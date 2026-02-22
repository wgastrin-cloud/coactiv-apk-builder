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

['apks', 'builds', 'keystore'].forEach(d => {
  if (!fs.existsSync(path.join(__dirname, d))) fs.mkdirSync(path.join(__dirname, d), { recursive: true });
});
generateTemplate();

app.get('/', (req, res) => res.json({ service: 'Co-Activ APK Builder', status: 'running' }));

app.post('/generate', async (req, res) => {
  const { site_id, site_name } = req.body;
  if (!site_id || !site_name) return res.status(400).json({ error: 'site_id et site_name requis' });
  const safeId = site_id.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, `coactiv-${safeId}.apk`);
  const errPath = path.join(APK_DIR, `coactiv-${safeId}.error`);
  if (fs.existsSync(errPath)) fs.unlinkSync(errPath);
  if (fs.existsSync(apkPath)) return res.json({ success: true, status: 'ready', download_url: `/download/${safeId}` });
  res.json({ success: true, status: 'building', status_url: `/status/${safeId}` });
  buildApk(safeId, site_id, site_name).catch(e => console.error('[BUILD]', e.message));
});

app.get('/download/:siteId', (req, res) => {
  const safeId = req.params.siteId.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, `coactiv-${safeId}.apk`);
  if (!fs.existsSync(apkPath)) return res.status(404).json({ error: 'APK not found' });
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
  if (fs.existsSync(errPath)) return res.json({ site_id: safeId, status: 'error', error: JSON.parse(fs.readFileSync(errPath,'utf8')).error });
  if (fs.existsSync(path.join(__dirname, 'builds', safeId))) return res.json({ site_id: safeId, status: 'building' });
  res.json({ site_id: safeId, status: 'not_found' });
});

app.get('/list', (req, res) => {
  const files = fs.readdirSync(APK_DIR).filter(f => f.endsWith('.apk'));
  res.json({ count: files.length, apks: files.map(f => ({ site_id: f.replace('coactiv-','').replace('.apk','') }))});
});

async function buildApk(safeId, siteId, siteName) {
  const buildDir = path.join(__dirname, 'builds', safeId);
  const apkPath = path.join(APK_DIR, `coactiv-${safeId}.apk`);
  const url = `https://co-activ.netlify.app/push.html?site=${siteId}`;

  console.log(`\n=== BUILD: ${siteName} (${safeId}) ===`);

  try {
    // Clean start
    if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
    
    // Create fresh build directory structure
    const srcDir = path.join(buildDir, 'src');
    const resDir = path.join(buildDir, 'res');
    const outDir = path.join(buildDir, 'out');
    const compiledResDir = path.join(outDir, 'compiled_res');
    const rJavaDir = path.join(outDir, 'rjava');
    const classesDir = path.join(outDir, 'classes');
    const dexDir = path.join(outDir, 'dex');
    
    [srcDir, resDir, compiledResDir, rJavaDir, classesDir, dexDir].forEach(d => fs.mkdirSync(d, { recursive: true }));
    
    // Copy only what we need from template
    copyDir(path.join(ANDROID_DIR, 'app/src/main/res'), resDir);
    
    // Create manifest
    fs.writeFileSync(path.join(buildDir, 'AndroidManifest.xml'), 
      fs.readFileSync(path.join(ANDROID_DIR, 'app/src/main/AndroidManifest.xml'), 'utf8')
        .replace(/PLACEHOLDER_APP_NAME/g, 'Co-Activ ' + siteName)
    );
    
    // Create MainActivity with correct URL
    fs.mkdirSync(path.join(srcDir, 'com/coactiv/push'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'com/coactiv/push/MainActivity.java'),
      fs.readFileSync(path.join(ANDROID_DIR, 'app/src/main/java/com/coactiv/push/MainActivity.java'), 'utf8')
        .replace(/PLACEHOLDER_URL/g, url)
    );

    const androidJar = findAndroidJar();
    if (!androidJar) throw new Error('android.jar not found');

    // 1. aapt2 compile
    console.log('  1/7 aapt2 compile');
    const resFiles = getAllFiles(resDir).filter(f => !f.includes('.DS_Store'));
    for (const f of resFiles) {
      try { execSync(`${BUILD_TOOLS}/aapt2 compile "${f}" -o "${compiledResDir}"`, { stdio: 'pipe' }); } catch(e) {}
    }

    // 2. aapt2 link
    console.log('  2/7 aapt2 link');
    const flats = fs.readdirSync(compiledResDir).filter(f => f.endsWith('.flat')).map(f => path.join(compiledResDir, f));
    const linkedApk = path.join(outDir, 'linked.apk');
    const flatArgs = flats.map(f => `"${f}"`).join(' ');
    execSync(`${BUILD_TOOLS}/aapt2 link -o "${linkedApk}" -I "${androidJar}" --manifest "${path.join(buildDir, 'AndroidManifest.xml')}" --java "${rJavaDir}" ${flatArgs}`, { stdio: 'pipe' });

    // 3. javac
    console.log('  3/7 javac');
    const mainJava = path.join(srcDir, 'com/coactiv/push/MainActivity.java');
    const rJavaFiles = getAllFiles(rJavaDir).filter(f => f.endsWith('.java'));
    const javaFiles = [mainJava, ...rJavaFiles].map(f => `"${f}"`).join(' ');
    execSync(`javac -encoding UTF-8 -source 1.8 -target 1.8 -cp "${androidJar}" -d "${classesDir}" ${javaFiles}`, { stdio: 'pipe' });

    // 4. d8 (dex) - list all .class files from classesDir ONLY
    console.log('  4/7 d8');
    const allClassFiles = getAllFiles(classesDir).filter(f => f.endsWith('.class'));
    console.log(`     Found ${allClassFiles.length} class files`);
    
    // Use a file list to avoid command line too long
    const classListFile = path.join(outDir, 'classlist.txt');
    fs.writeFileSync(classListFile, allClassFiles.join('\n'));
    
    execSync(`${BUILD_TOOLS}/d8 --lib "${androidJar}" --min-api 21 --output "${dexDir}" ${allClassFiles.map(f => `"${f}"`).join(' ')}`, { stdio: 'pipe' });

    // 5. Assemble APK
    console.log('  5/7 assemble');
    const unsignedApk = path.join(outDir, 'unsigned.apk');
    fs.copyFileSync(linkedApk, unsignedApk);
    execSync(`cd "${dexDir}" && zip -j "${unsignedApk}" classes.dex`, { stdio: 'pipe' });

    // 6. zipalign
    console.log('  6/7 zipalign');
    const alignedApk = path.join(outDir, 'aligned.apk');
    execSync(`${BUILD_TOOLS}/zipalign -f 4 "${unsignedApk}" "${alignedApk}"`, { stdio: 'pipe' });

    // 7. sign
    console.log('  7/7 apksigner');
    const signedApk = path.join(outDir, 'signed.apk');
    execSync(`${BUILD_TOOLS}/apksigner sign --ks "${KEYSTORE_PATH}" --ks-key-alias coactiv --ks-pass pass:${KEYSTORE_PASS} --key-pass pass:${KEYSTORE_PASS} --out "${signedApk}" "${alignedApk}"`, { stdio: 'pipe' });

    fs.copyFileSync(signedApk, apkPath);
    console.log(`=== BUILD OK: ${(fs.statSync(apkPath).size/1048576).toFixed(1)} Mo ===`);

  } catch(err) {
    console.error(`=== BUILD FAIL: ${err.message} ===`);
    fs.writeFileSync(path.join(APK_DIR, `coactiv-${safeId}.error`), JSON.stringify({ error: err.message }));
  } finally {
    try { if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}
  }
}

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

function getAllFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? getAllFiles(p, files) : files.push(p);
  }
  return files;
}

app.listen(PORT, '0.0.0.0', () => console.log(`APK Builder on port ${PORT}`));
