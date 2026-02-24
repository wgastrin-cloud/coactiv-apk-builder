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
  var p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});
generateTemplate();

// Routes
app.get('/', function(req, res) { res.json({ service: 'Co-Activ APK Builder', status: 'running' }); });

app.post('/generate', function(req, res) {
  var site_id = req.body.site_id;
  var site_name = req.body.site_name;
  if (!site_id || !site_name) return res.status(400).json({ error: 'site_id et site_name requis' });
  var safeId = site_id.replace(/[^a-zA-Z0-9_-]/g, '');
  var apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  var errPath = path.join(APK_DIR, 'coactiv-' + safeId + '.error');
  if (fs.existsSync(errPath)) fs.unlinkSync(errPath);
  if (fs.existsSync(apkPath)) return res.json({ success: true, status: 'ready', download_url: '/download/' + safeId });
  res.json({ success: true, status: 'building', status_url: '/status/' + safeId });
  buildApk(safeId, site_id, site_name);
});

app.get('/download/:id', function(req, res) {
  var safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  var p = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  res.download(p, 'CoActiv-' + safeId + '.apk');
});

app.get('/status/:id', function(req, res) {
  var safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  var apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  var errPath = path.join(APK_DIR, 'coactiv-' + safeId + '.error');
  if (fs.existsSync(apkPath)) {
    return res.json({ site_id: safeId, status: 'ready', download_url: '/download/' + safeId, size_mb: (fs.statSync(apkPath).size / 1048576).toFixed(1) });
  }
  if (fs.existsSync(errPath)) return res.json({ site_id: safeId, status: 'error', error: JSON.parse(fs.readFileSync(errPath, 'utf8')).error });
  if (fs.existsSync(path.join(__dirname, 'builds', safeId))) return res.json({ site_id: safeId, status: 'building' });
  res.json({ site_id: safeId, status: 'not_found' });
});

app.get('/list', function(req, res) {
  var files = fs.readdirSync(APK_DIR).filter(function(f) { return f.endsWith('.apk'); });
  res.json({ count: files.length, apks: files.map(function(f) { return { site_id: f.replace('coactiv-', '').replace('.apk', '') }; }) });
});

// Delete endpoint to allow regeneration
app.delete('/delete/:id', function(req, res) {
  var safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  var apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  var errPath = path.join(APK_DIR, 'coactiv-' + safeId + '.error');
  if (fs.existsSync(apkPath)) fs.unlinkSync(apkPath);
  if (fs.existsSync(errPath)) fs.unlinkSync(errPath);
  res.json({ success: true });
});

// Build
function buildApk(safeId, siteId, siteName) {
  var B = path.join(__dirname, 'builds', safeId);
  var apkOut = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  var url = 'https://co-activ.netlify.app/push.html?site=' + siteId;

  console.log('\n========================================');
  console.log('BUILD START: ' + siteName + ' (' + safeId + ')');
  console.log('========================================');

  try {
    // Clean
    if (fs.existsSync(B)) fs.rmSync(B, { recursive: true, force: true });
    fs.mkdirSync(B, { recursive: true });

    var RES = path.join(B, 'res');
    var CRES = path.join(B, 'compiled_res');
    var RJAVA = path.join(B, 'rjava');
    var SRC = path.join(B, 'src', 'com', 'coactiv', 'push');
    var CLASSES = path.join(B, 'classes');
    var DEX = path.join(B, 'dex');
    [RES, CRES, RJAVA, SRC, CLASSES, DEX].forEach(function(d) { fs.mkdirSync(d, { recursive: true }); });

    // Copy resources
    copyDir(path.join(ANDROID_DIR, 'app/src/main/res'), RES);

    // Write AndroidManifest.xml
    var manifest = fs.readFileSync(path.join(ANDROID_DIR, 'app/src/main/AndroidManifest.xml'), 'utf8');
    manifest = manifest.replace(/PLACEHOLDER_APP_NAME/g, 'Co-Activ ' + siteName);
    fs.writeFileSync(path.join(B, 'AndroidManifest.xml'), manifest);

    // Write MainActivity.java with URL
    var java = fs.readFileSync(path.join(ANDROID_DIR, 'app/src/main/java/com/coactiv/push/MainActivity.java'), 'utf8');
    java = java.replace(/PLACEHOLDER_URL/g, url);
    fs.writeFileSync(path.join(SRC, 'MainActivity.java'), java);

    var androidJar = findAndroidJar();
    if (!androidJar) throw new Error('android.jar not found');
    console.log('android.jar: ' + androidJar);

    // Step 1: aapt2 compile
    console.log('[1/7] aapt2 compile');
    var resFiles = getAllFiles(RES);
    var compiled = 0;
    for (var i = 0; i < resFiles.length; i++) {
      try {
        execSync(BUILD_TOOLS + '/aapt2 compile "' + resFiles[i] + '" -o "' + CRES + '"', { stdio: 'pipe' });
        compiled++;
      } catch (e) {}
    }
    console.log('  Compiled ' + compiled + ' resources');

    // Step 2: aapt2 link
    console.log('[2/7] aapt2 link');
    var flatFiles = fs.readdirSync(CRES).filter(function(f) { return f.endsWith('.flat'); });
    console.log('  Found ' + flatFiles.length + ' flat files');
    var flatArgs = flatFiles.map(function(f) { return '"' + path.join(CRES, f) + '"'; }).join(' ');
    var linkedApk = path.join(B, 'linked.apk');
    execSync(BUILD_TOOLS + '/aapt2 link -o "' + linkedApk + '" -I "' + androidJar + '" --manifest "' + path.join(B, 'AndroidManifest.xml') + '" --java "' + RJAVA + '" --min-sdk-version 21 --target-sdk-version 33 --version-code 1 --version-name 1.0 ' + flatArgs, { stdio: 'pipe' });
    console.log('  linked.apk: ' + fs.statSync(linkedApk).size + ' bytes');

    // Step 3: javac
    console.log('[3/7] javac');
    var mainJava = path.join(SRC, 'MainActivity.java');
    var rJavaFiles = getAllFiles(RJAVA).filter(function(f) { return f.endsWith('.java'); });
    console.log('  R.java files: ' + rJavaFiles.length);
    rJavaFiles.forEach(function(f) { console.log('    ' + f); });
    var allJava = [mainJava].concat(rJavaFiles);
    var javaArgs = allJava.map(function(f) { return '"' + f + '"'; }).join(' ');
    execSync('javac -encoding UTF-8 -source 1.8 -target 1.8 -cp "' + androidJar + '" -d "' + CLASSES + '" ' + javaArgs, { stdio: 'pipe' });
    
    var classFiles = getAllFiles(CLASSES).filter(function(f) { return f.endsWith('.class'); });
    console.log('  Produced ' + classFiles.length + ' class files:');
    classFiles.forEach(function(f) { console.log('    ' + path.relative(CLASSES, f)); });

    // Step 4: d8 via JAR
    console.log('[4/7] d8');
    var jarFile = path.join(B, 'app-classes.jar');
    execSync('cd "' + CLASSES + '" && jar cf "' + jarFile + '" .', { stdio: 'pipe' });
    console.log('  app-classes.jar: ' + fs.statSync(jarFile).size + ' bytes');
    execSync(BUILD_TOOLS + '/d8 --lib "' + androidJar + '" --output "' + DEX + '" "' + jarFile + '"', { stdio: 'pipe' });
    
    var dexFile = path.join(DEX, 'classes.dex');
    if (!fs.existsSync(dexFile)) throw new Error('classes.dex was not created by d8!');
    console.log('  classes.dex: ' + fs.statSync(dexFile).size + ' bytes');

    // Step 5: Build APK
    console.log('[5/7] assemble');
    var unsignedApk = path.join(B, 'unsigned.apk');
    fs.copyFileSync(linkedApk, unsignedApk);
    console.log('  unsigned.apk before dex: ' + fs.statSync(unsignedApk).size + ' bytes');
    
    // Add classes.dex to the APK
    execSync('cd "' + DEX + '" && zip -j "' + unsignedApk + '" classes.dex', { stdio: 'pipe' });
    console.log('  unsigned.apk after dex: ' + fs.statSync(unsignedApk).size + ' bytes');
    
    // Verify classes.dex is in the APK
    var zipList = execSync('unzip -l "' + unsignedApk + '"', { encoding: 'utf8' });
    console.log('  APK contents:');
    console.log(zipList);

    // Step 6: zipalign
    console.log('[6/7] zipalign');
    var alignedApk = path.join(B, 'aligned.apk');
    execSync(BUILD_TOOLS + '/zipalign -f 4 "' + unsignedApk + '" "' + alignedApk + '"', { stdio: 'pipe' });
    console.log('  aligned.apk: ' + fs.statSync(alignedApk).size + ' bytes');

    // Step 7: sign
    console.log('[7/7] apksigner');
    var signedApk = path.join(B, 'signed.apk');
    execSync(BUILD_TOOLS + '/apksigner sign --ks "' + KEYSTORE_PATH + '" --ks-key-alias coactiv --ks-pass pass:' + KEYSTORE_PASS + ' --key-pass pass:' + KEYSTORE_PASS + ' --out "' + signedApk + '" "' + alignedApk + '"', { stdio: 'pipe' });
    console.log('  signed.apk: ' + fs.statSync(signedApk).size + ' bytes');

    // Verify
    try {
      var verifyOut = execSync(BUILD_TOOLS + '/apksigner verify "' + signedApk + '"', { encoding: 'utf8' });
      console.log('  Signature verify: OK');
    } catch(ve) {
      console.log('  Signature verify WARNING: ' + ve.message);
    }

    fs.copyFileSync(signedApk, apkOut);
    var finalSize = fs.statSync(apkOut).size;
    console.log('========================================');
    console.log('BUILD OK: ' + (finalSize / 1024).toFixed(1) + ' KB');
    console.log('========================================');

    if (finalSize < 1000) {
      console.log('WARNING: APK is suspiciously small! Something may be wrong.');
    }

  } catch (err) {
    console.log('========================================');
    console.log('BUILD FAIL: ' + err.message);
    console.log('========================================');
    if (err.stderr) console.log('STDERR: ' + err.stderr.toString().substring(0, 1000));
    fs.writeFileSync(path.join(APK_DIR, 'coactiv-' + safeId + '.error'), JSON.stringify({ error: err.message.substring(0, 500) }));
  } finally {
    try { if (fs.existsSync(B)) fs.rmSync(B, { recursive: true, force: true }); } catch (e) {}
  }
}

function findAndroidJar() {
  var p = path.join(ANDROID_HOME, 'platforms', 'android-33', 'android.jar');
  if (fs.existsSync(p)) return p;
  try {
    execSync(ANDROID_HOME + '/cmdline-tools/latest/bin/sdkmanager "platforms;android-33" --sdk_root=' + ANDROID_HOME, { stdio: 'pipe' });
    if (fs.existsSync(p)) return p;
  } catch (e) {}
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  var entries = fs.readdirSync(src, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var s = path.join(src, entries[i].name);
    var d = path.join(dest, entries[i].name);
    if (entries[i].isDirectory()) copyDir(s, d);
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
