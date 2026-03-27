const express = require('express');
const cors = require('cors');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APK_DIR = path.join(__dirname, 'apks');
const BUILDS_DIR = path.join(__dirname, 'builds');

['apks', 'builds'].forEach(d => {
  const p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

app.get('/', (req, res) => res.json({ service: 'Co-Activ APK Builder', status: 'running' }));

// ─── GENERATE ────────────────────────────────────────────────────────────────
app.post('/generate', async (req, res) => {
  const site_id = req.body.site_id;
  const site_name = req.body.site_name || site_id;
  if (!site_id || !site_name) return res.status(400).json({ error: 'site_id et site_name requis' });

  const safeId = site_id.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  const errPath = path.join(APK_DIR, 'coactiv-' + safeId + '.error');

  if (fs.existsSync(apkPath)) {
    return res.json({ success: true, status: 'ready', download_url: '/download/' + safeId });
  }

  if (fs.existsSync(errPath)) fs.unlinkSync(errPath);

  res.json({ success: true, status: 'building', status_url: '/status/' + safeId });
  buildApk(safeId, site_id, site_name);
});

// ─── STATUS ──────────────────────────────────────────────────────────────────
app.get('/status/:id', (req, res) => {
  const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  const errPath = path.join(APK_DIR, 'coactiv-' + safeId + '.error');

  if (fs.existsSync(apkPath)) {
    const size_mb = (fs.statSync(apkPath).size / 1024 / 1024).toFixed(1);
    return res.json({ site_id: safeId, status: 'ready', download_url: '/download/' + safeId, size_mb });
  }
  if (fs.existsSync(errPath)) {
    return res.json({ site_id: safeId, status: 'error', error: fs.readFileSync(errPath, 'utf8') });
  }
  const buildDir = path.join(BUILDS_DIR, safeId);
  if (fs.existsSync(buildDir)) return res.json({ site_id: safeId, status: 'building' });
  return res.json({ site_id: safeId, status: 'not found' });
});

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────
app.get('/download/:id', (req, res) => {
  const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  if (!fs.existsSync(apkPath)) return res.status(404).json({ error: 'not found' });
  res.download(apkPath, 'CoActiv-' + safeId + '.apk');
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
app.delete('/delete/:id', (req, res) => {
  const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  const errPath = path.join(APK_DIR, 'coactiv-' + safeId + '.error');
  if (fs.existsSync(apkPath)) fs.unlinkSync(apkPath);
  if (fs.existsSync(errPath)) fs.unlinkSync(errPath);
  res.json({ success: true });
});

// ─── LIST ─────────────────────────────────────────────────────────────────────
app.get('/list', (req, res) => {
  const files = fs.readdirSync(APK_DIR).filter(f => f.endsWith('.apk'));
  res.json({ count: files.length, apks: files.map(f => f.replace('coactiv-', '').replace('.apk', '')) });
});

// ─── BUILD ────────────────────────────────────────────────────────────────────
async function buildApk(safeId, site_id, site_name) {
  const buildDir = path.join(BUILDS_DIR, safeId);
  const apkPath = path.join(APK_DIR, 'coactiv-' + safeId + '.apk');
  const errPath = path.join(APK_DIR, 'coactiv-' + safeId + '.error');

  console.log('========================================');
  console.log('BUILD START: ' + site_name + ' (' + safeId + ')');
  console.log('========================================');

  try {
    // Nettoyer
    if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });

    const targetUrl = 'https://co-activ.site/index-agent.html?site=' + site_id;
    const packageName = 'com.coactiv.' + safeId.toLowerCase().replace(/[^a-z0-9]/g, '');
    const appName = 'Co-Activ ' + site_name;

    // Initialiser Bubblewrap
    console.log('[1/4] Init Bubblewrap...');
    const twaConfig = {
      packageId: packageName,
      host: 'co-activ.site',
      name: appName,
      launcherName: 'Co-Activ',
      themeColor: '#16a34a',
      navigationColor: '#16a34a',
      backgroundColor: '#ffffff',
      startUrl: '/index-agent.html?site=' + site_id,
      iconUrl: 'https://co-activ.site/icon-512.png',
      maskableIconUrl: 'https://co-activ.site/icon-512.png',
      appVersion: '1.0.0',
      appVersionCode: 1,
      display: 'standalone',
      orientation: 'portrait',
      enableNotifications: true,
      shortcuts: [],
      webManifestUrl: 'https://co-activ.site/manifest.json',
      signingKey: {
        path: path.join(__dirname, 'keystore', 'coactiv.keystore'),
        alias: 'coactiv',
        keypassword: 'coactiv123',
        storepassword: 'coactiv123'
      },
      generatorApp: 'bubblewrap-cli',
      sdkPath: process.env.ANDROID_HOME || '/opt/android-sdk',
      minSdkVersion: 21,
      targetSdkVersion: 33,
    };

    fs.writeFileSync(path.join(buildDir, 'twa-manifest.json'), JSON.stringify(twaConfig, null, 2));

    // Bubblewrap init + build
    console.log('[2/4] Bubblewrap init...');
    execSync(
      'npx @bubblewrap/cli@latest init --manifest=https://co-activ.site/manifest.json --directory=' + buildDir,
      { cwd: buildDir, stdio: 'pipe', timeout: 300000,
        env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME || '/opt/java/jdk-17.0.12' } }
    );

    console.log('[3/4] Bubblewrap build...');
    execSync(
      'npx @bubblewrap/cli@latest build',
      { cwd: buildDir, stdio: 'pipe', timeout: 600000,
        env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME || '/opt/java/jdk-17.0.12' } }
    );

    // Trouver l'APK généré
    console.log('[4/4] Recherche APK...');
    const apkCandidates = [
      path.join(buildDir, 'app-release-signed.apk'),
      path.join(buildDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
      path.join(buildDir, 'app-release.apk'),
    ];

    let found = null;
    for (const c of apkCandidates) {
      if (fs.existsSync(c)) { found = c; break; }
    }

    // Recherche récursive si pas trouvé
    if (!found) {
      const result = execSync('find ' + buildDir + ' -name "*.apk" 2>/dev/null', { encoding: 'utf8' }).trim();
      if (result) found = result.split('\n')[0];
    }

    if (!found) throw new Error('APK introuvable après build');

    fs.copyFileSync(found, apkPath);
    fs.rmSync(buildDir, { recursive: true, force: true });
    console.log('✅ APK prêt: ' + apkPath + ' (' + (fs.statSync(apkPath).size / 1024 / 1024).toFixed(1) + ' Mo)');

  } catch (err) {
    console.error('❌ BUILD ERREUR:', err.message || err);
    fs.writeFileSync(errPath, (err.message || String(err)).substring(0, 2000));
    if (fs.existsSync(buildDir)) {
      try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}
    }
  }
}

app.listen(PORT, () => console.log('Co-Activ APK Builder démarré sur port ' + PORT));
