const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { generateTemplate, ANDROID_DIR } = require('./generate-template');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APK_DIR = path.join(__dirname, 'apks');
const KEYSTORE_PATH = path.join(__dirname, 'keystore', 'coactiv.keystore');
const KEYSTORE_PASS = process.env.KEYSTORE_PASSWORD || 'coactiv123';
const ANDROID_HOME = process.env.ANDROID_HOME || '/opt/android-sdk';
const BUILD_TOOLS = path.join(ANDROID_HOME, 'build-tools', '33.0.2');

// Init
['apks', 'builds', 'keystore'].forEach(d => {
  if (!fs.existsSync(path.join(__dirname, d))) fs.mkdirSync(path.join(__dirname, d), { recursive: true });
});
generateTemplate();

// ===== ROUTES =====
app.get('/', (req, res) => {
  res.json({ service: 'Co-Activ APK Builder', status: 'running' });
});

app.post('/generate', async (req, res) => {
  const { site_id, site_name } = req.body;
  if (!site_id || !site_name) return res.status(400).json({ error: 'site_id et site_name requis' });

  const safeId = site_id.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, `coactiv-${safeId}.apk`);
  const errPath = path.join(APK_DIR, `coactiv-${safeId}.error`);

  // Nettoyer ancien fichier erreur
  if (fs.existsSync(errPath)) fs.unlinkSync(errPath);

  if (fs.existsSync(apkPath)) {
    return res.json({ success: true, status: 'ready', download_url: `/download/${safeId}` });
  }

  res.json({ success: true, status: 'building', status_url: `/status/${safeId}` });
  buildApk(safeId, site_id, site_name).catch(e => console.error('[BUILD]', e.message));
});

app.get('/download/:siteId', (req, res) => {
  const safeId = req.params.siteId.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, `coactiv-${safeId}.apk`);
  if (!fs.existsSync(apkPath)) return res.status(404).json({ error: 'APK non trouve' });
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.download(apkPath, `CoActiv-${safeId}.apk`);
});

app.get('/status/:siteId', (req, res) => {
  const safeId = req.params.siteId.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, `coactiv-${safeId}.apk`);
  const errPath = path.join(APK_DIR, `coactiv-${safeId}.error`);
  if (fs.existsSync(apkPath)) {
    const s = fs.statSync(apkPath);
    return res.json({ site_id: safeId, status: 'ready', download_url: `/download/${safeId}`, size_mb: (s.size/1048576).toFixed(1) });
  }
  if (fs.existsSync(errPath)) {
    return res.json({ site_id: safeId, status: 'error', error: JSON.parse(fs.readFileSync(errPath,'utf8')).error });
  }
  if (fs.existsSync(path.join(__dirname, 'builds', safeId))) {
    return res.json({ site_id: safeId, status: 'building' });
  }
  res.json({ site_id: safeId, status: 'not_found' });
});

app.get('/list', (req, res) => {
  const files = fs.readdirSync(APK_DIR).filter(f => f.endsWith('.apk'));
  res.json({ count: files.length, apks: files.map(f => ({
    site_id: f.replace('coactiv-','').replace('.apk',''),
    download_url: `/download/${f.replace('coactiv-','').replace('.apk','')}`
  }))});
});

// ===== BUILD =====
async function buildApk(safeId, siteId, siteName) {
  const buildDir = path.join(__dirname, 'builds', safeId);
  const apkPath = path.join(APK_DIR, `coactiv-${safeId}.apk`);
  const url = `https://co-activ.netlify.app/push.html?site=${siteId}`;

  console.log(`\n=== BUILD: ${siteName} (${safeId}) ===`);

  try {
    if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true });
    copyDir(ANDROID_DIR, buildDir);

    // Patch uniquement URL et nom (PAS le package)
    replaceIn(path.join(buildDir, 'app/src/main/AndroidManifest.xml'), 'PLACEHOLDER_APP_NAME', `Co-Activ ${siteName}`);
    replaceIn(path.join(buildDir, 'app/src/main/java/com/coactiv/push/MainActivity.java'), 'PLACEHOLDER_URL', url);

    const androidJar = findAndroidJar();
    if (!androidJar) throw new Error('android.jar not found');

    const srcMain = path.join(buildDir, 'app/src/main');
    const out = path.join(buildDir, 'output');
    const compiledRes = path.join(out, 'res');
    const rJavaDir = path.join(out, 'rjava');
    const classesDir = path.join(out, 'classes');
    [out, compiledRes, rJavaDir, classesDir].forEach(d => fs.mkdirSync(d, { recursive: true }));

    // 1. aapt2 compile resources
    console.log('  1. aapt2 compile');
    const resFiles = getAllFiles(path.join(srcMain, 'res')).filter(f => !f.includes('.DS_Store'));
    for (const f of resFiles) {
      try { execSync(`${BUILD_TOOLS}/aapt2 compile "${f}" -o "${compiledRes}"`, { stdio: 'pipe' }); } catch(e) {}
    }

    // 2. aapt2 link
    console.log('  2. aapt2 link');
    const flats = fs.readdirSync(compiledRes).filter(f => f.endsWith('.flat')).map(f => `"${path.join(compiledRes, f)}"`).join(' ');
    const linkedApk = path.join(out, 'linked.apk');
    execSync(`${BUILD_TOOLS}/aapt2 link -o "${linkedApk}" -I "${androidJar}" --manifest "${path.join(srcMain, 'AndroidManifest.xml')}" --java "${rJavaDir}" ${flats}`, { stdio: 'pipe' });

    // 3. javac - compile ONLY from classesDir to avoid duplicates
    console.log('  3. javac');
    const javaFile = path.join(srcMain, 'java/com/coactiv/push/MainActivity.java');
    const rJavaFiles = getAllFiles(rJavaDir).filter(f => f.endsWith('.java'));
    const allJava = [javaFile, ...rJavaFiles].map(f => `"${f}"`).join(' ');
    execSync(`javac -encoding UTF-8 -source 1.8 -target 1.8 -cp "${androidJar}" -d "${classesDir}" ${allJava}`, { stdio: 'pipe' });

    // 4. d8 - convert to dex
    console.log('  4. d8');
    const classFiles = getAllFiles(classesDir).filter(f => f.endsWith('.class')).map(f => `"${f}"`).join(' ');
    const dexOut = path.join(out, 'dex');
    fs.mkdirSync(dexOut, { recursive: true });
    execSync(`${BUILD_TOOLS}/d8 --lib "${androidJar}" --output "${dexOut}" ${classFiles}`, { stdio: 'pipe' });

    // 5. Build APK
    console.log('  5. Assemble APK');
    const unsignedApk = path.join(out, 'unsigned.apk');
    fs.copyFileSync(linkedApk, unsignedApk);
    const dexFile = path.join(dexOut, 'classes.dex');
    if (fs.existsSync(dexFile)) {
      execSync(`cd "${dexOut}" && zip -j "${unsignedApk}" classes.dex`, { stdio: 'pipe' });
    }

    // 6. zipalign
    console.log('  6. zipalign');
    const alignedApk = path.join(out, 'aligned.apk');
    execSync(`${BUILD_TOOLS}/zipalign -f 4 "${unsignedApk}" "${alignedApk}"`, { stdio: 'pipe' });

    // 7. sign
    console.log('  7. apksigner');
    const signedApk = path.join(out, 'signed.apk');
    execSync(`${BUILD_TOOLS}/apksigner sign --ks "${KEYSTORE_PATH}" --ks-key-alias coactiv --ks-pass pass:${KEYSTORE_PASS} --key-pass pass:${KEYSTORE_PASS} --out "${signedApk}" "${alignedApk}"`, { stdio: 'pipe' });

    fs.copyFileSync(signedApk, apkPath);
    console.log(`=== BUILD OK: ${(fs.statSync(apkPath).size/1048576).toFixed(1)} Mo ===`);

  } catch(err) {
    console.error(`=== BUILD FAIL ${safeId}: ${err.message} ===`);
    fs.writeFileSync(path.join(APK_DIR, `coactiv-${safeId}.error`), JSON.stringify({ error: err.message }));
  } finally {
    try { if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}
  }
}

// ===== Helpers =====
function findAndroidJar() {
  const p = path.join(ANDROID_HOME, 'platforms/android-33/android.jar');
  if (fs.existsSync(p)) return p;
  try {
    execSync(`${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager "platforms;android-33" --sdk_root=${ANDROID_HOME}`, { stdio: 'pipe' });
    return p;
  } catch(e) { return null; }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

function replaceIn(file, search, replace) {
  if (!fs.existsSync(file)) return;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(new RegExp(search, 'g'), replace));
}

function getAllFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? getAllFiles(p, files) : files.push(p);
  }
  return files;
}

app.listen(PORT, '0.0.0.0', () => console.log(`APK Builder running on port ${PORT}`));
