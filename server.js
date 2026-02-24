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
  const p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});
generateTemplate();

// --- Routes ---
app.get('/', (req, res) => res.json({ service: 'Co-Activ APK Builder', status: 'running' }));

app.post('/generate', async (req, res) => {
  const { site_id, site_name } = req.body;
  if (!site_id || !site_name) return res.status(400).json({ error: 'site_id et site_name requis' });
  const safeId = site_id.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  const errPath = path.join(APK_DIR, 'coactiv-' + safeId + '.error');
  if (fs.existsSync(errPath)) fs.unlinkSync(errPath);
  if (fs.existsSync(apkPath)) return res.json({ success: true, status: 'ready', download_url: '/download/' + safeId });
  res.json({ success: true, status: 'building', status_url: '/status/' + safeId });
  buildApk(safeId, site_id, site_name).catch(e => console.error('[BUILD ERR]', e.message));
});

app.get('/download/:id', (req, res) => {
  const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const p = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  res.download(p, 'CoActiv-' + safeId + '.apk');
});

app.get('/status/:id', (req, res) => {
  const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  const errPath = path.join(APK_DIR, 'coactiv-' + safeId + '.error');
  if (fs.existsSync(apkPath)) {
    return res.json({ site_id: safeId, status: 'ready', download_url: '/download/' + safeId, size_mb: (fs.statSync(apkPath).size / 1048576).toFixed(1) });
  }
  if (fs.existsSync(errPath)) {
    return res.json({ site_id: safeId, status: 'error', error: JSON.parse(fs.readFileSync(errPath, 'utf8')).error });
  }
  if (fs.existsSync(path.join(__dirname, 'builds', safeId))) {
    return res.json({ site_id: safeId, status: 'building' });
  }
  res.json({ site_id: safeId, status: 'not_found' });
});

app.get('/list', (req, res) => {
  const files = fs.readdirSync(APK_DIR).filter(f => f.endsWith('.apk'));
  res.json({ count: files.length, apks: files.map(f => ({ site_id: f.replace('coactiv-', '').replace('.apk', '') })) });
});

// --- Build ---
async function buildApk(safeId, siteId, siteName) {
  const B = path.join(__dirname, 'builds', safeId);
  const apkOut = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  const url = 'https://co-activ.netlify.app/push.html?site=' + siteId;

  console.log('\n=== BUILD START: ' + siteName + ' (' + safeId + ') ===');

  try {
    // 0. Clean
    if (fs.existsSync(B)) fs.rmSync(B, { recursive: true, force: true });
    fs.mkdirSync(B, { recursive: true });

    // Directories
    const RES     = path.join(B, 'res');
    const CRES    = path.join(B, 'compiled_res');
    const RJAVA   = path.join(B, 'rjava');
    const SRC     = path.join(B, 'src', 'com', 'coactiv', 'push');
    const CLASSES = path.join(B, 'classes');
    const DEX     = path.join(B, 'dex');
    [RES, CRES, RJAVA, SRC, CLASSES, DEX].forEach(d => fs.mkdirSync(d, { recursive: true }));

    // 0a. Copy resources from template
    copyDir(path.join(ANDROID_DIR, 'app/src/main/res'), RES);

    // 0b. Write AndroidManifest.xml with site name
    const manifestSrc = fs.readFileSync(path.join(ANDROID_DIR, 'app/src/main/AndroidManifest.xml'), 'utf8');
    fs.writeFileSync(path.join(B, 'AndroidManifest.xml'), manifestSrc.replace(/PLACEHOLDER_APP_NAME/g, 'Co-Activ ' + siteName));

    // 0c. Write MainActivity.java with URL
    const javaSrc = fs.readFileSync(path.join(ANDROID_DIR, 'app/src/main/java/com/coactiv/push/MainActivity.java'), 'utf8');
    fs.writeFileSync(path.join(SRC, 'MainActivity.java'), javaSrc.replace(/PLACEHOLDER_URL/g, url));

    // Check android.jar
    const androidJar = findAndroidJar();
    if (!androidJar) throw new Error('android.jar not found');

    // 1. aapt2 compile each resource file
    console.log('  [1/7] aapt2 compile');
    const resFiles = getAllFiles(RES);
    let compiled = 0;
    for (const f of resFiles) {
      try {
        execSync(BUILD_TOOLS + '/aapt2 compile "' + f + '" -o "' + CRES + '"', { stdio: 'pipe' });
        compiled++;
      } catch (e) { /* skip non-compilable files like .DS_Store */ }
    }
    console.log('     Compiled ' + compiled + ' resource files');

    // 2. aapt2 link
    console.log('  [2/7] aapt2 link');
    const flatFiles = fs.readdirSync(CRES).filter(f => f.endsWith('.flat'));
    console.log('     Found ' + flatFiles.length + ' flat files');
    const flatPaths = flatFiles.map(f => '"' + path.join(CRES, f) + '"').join(' ');
    const linkedApk = path.join(B, 'linked.apk');
    execSync(BUILD_TOOLS + '/aapt2 link -o "' + linkedApk + '" -I "' + androidJar + '" --manifest "' + path.join(B, 'AndroidManifest.xml') + '" --java "' + RJAVA + '" ' + flatPaths, { stdio: 'pipe' });

    // 3. javac - compile all .java files into CLASSES dir
    console.log('  [3/7] javac');
    const mainJava = path.join(SRC, 'MainActivity.java');
    const rJavaList = getAllFiles(RJAVA).filter(f => f.endsWith('.java'));
    console.log('     R.java files: ' + rJavaList.length);
    const allJavaArgs = [mainJava].concat(rJavaList).map(f => '"' + f + '"').join(' ');
    execSync('javac -encoding UTF-8 -source 1.8 -target 1.8 -cp "' + androidJar + '" -d "' + CLASSES + '" ' + allJavaArgs, { stdio: 'pipe' });

    // 3b. Log what javac produced
    const classFiles = getAllFiles(CLASSES).filter(f => f.endsWith('.class'));
    console.log('     Produced ' + classFiles.length + ' class files:');
    classFiles.forEach(f => console.log('       ' + f.replace(CLASSES, '')));

    // 4. d8 - convert .class to .dex via JAR (avoids duplicate class issues)
    console.log('  [4/7] d8');
    var jarFile = path.join(B, 'classes.jar');
    execSync('cd "' + CLASSES + '" && jar cf "' + jarFile + '" .', { stdio: 'pipe' });
    console.log('     Created classes.jar: ' + (fs.statSync(jarFile).size / 1024).toFixed(1) + ' KB');
    execSync(BUILD_TOOLS + '/d8 --lib "' + androidJar + '" --output "' + DEX + '" "' + jarFile + '"', { stdio: 'pipe' });

    // 5. Assemble APK (add classes.dex to linked.apk)
    console.log('  [5/7] assemble');
    const unsignedApk = path.join(B, 'unsigned.apk');
    fs.copyFileSync(linkedApk, unsignedApk);
    execSync('cd "' + DEX + '" && zip -j "' + unsignedApk + '" classes.dex', { stdio: 'pipe' });

    // 6. zipalign
    console.log('  [6/7] zipalign');
    const alignedApk = path.join(B, 'aligned.apk');
    execSync(BUILD_TOOLS + '/zipalign -f 4 "' + unsignedApk + '" "' + alignedApk + '"', { stdio: 'pipe' });

    // 7. apksigner
    console.log('  [7/7] apksigner');
    const signedApk = path.join(B, 'signed.apk');
    execSync(BUILD_TOOLS + '/apksigner sign --ks "' + KEYSTORE_PATH + '" --ks-key-alias coactiv --ks-pass pass:' + KEYSTORE_PASS + ' --key-pass pass:' + KEYSTORE_PASS + ' --out "' + signedApk + '" "' + alignedApk + '"', { stdio: 'pipe' });

    // Done
    fs.copyFileSync(signedApk, apkOut);
    console.log('=== BUILD OK: ' + (fs.statSync(apkOut).size / 1048576).toFixed(1) + ' Mo ===');

  } catch (err) {
    console.error('=== BUILD FAIL: ' + err.message + ' ===');
    if (err.stderr) console.error('STDERR: ' + err.stderr.toString().substring(0, 500));
    fs.writeFileSync(path.join(APK_DIR, 'coactiv-' + safeId + '.error'), JSON.stringify({ error: err.message.substring(0, 500) }));
  } finally {
    try { if (fs.existsSync(B)) fs.rmSync(B, { recursive: true, force: true }); } catch (e) {}
  }
}

function findAndroidJar() {
  const p = path.join(ANDROID_HOME, 'platforms', 'android-33', 'android.jar');
  if (fs.existsSync(p)) return p;
  try {
    execSync(ANDROID_HOME + '/cmdline-tools/latest/bin/sdkmanager "platforms;android-33" --sdk_root=' + ANDROID_HOME, { stdio: 'pipe' });
    if (fs.existsSync(p)) return p;
  } catch (e) {}
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function getAllFiles(dir, result) {
  if (!result) result = [];
  if (!fs.existsSync(dir)) return result;
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var full = path.join(dir, entries[i].name);
    if (entries[i].isDirectory()) getAllFiles(full, result);
    else result.push(full);
  }
  return result;
}

app.listen(PORT, '0.0.0.0', function() { console.log('APK Builder on port ' + PORT); });
