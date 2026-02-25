const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const TEMPLATE_DIR = path.join(__dirname, 'template');
const ANDROID_DIR = path.join(TEMPLATE_DIR, 'android-project');

// Download the real Co-Activ icon from Netlify
function downloadIcon(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadIcon(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download icon: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function generateTemplate() {
  console.log('Generating Android template...');

  const dirs = [
    'app/src/main/java/com/coactiv/push',
    'app/src/main/res/values',
    'app/src/main/res/mipmap-hdpi',
    'app/src/main/res/mipmap-mdpi',
    'app/src/main/res/mipmap-xhdpi',
    'app/src/main/res/mipmap-xxhdpi',
    'app/src/main/res/mipmap-xxxhdpi',
    'app/src/main/res/xml'
  ];
  dirs.forEach(d => fs.mkdirSync(path.join(ANDROID_DIR, d), { recursive: true }));

  // AndroidManifest.xml
  fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/AndroidManifest.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.coactiv.push">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="PLACEHOLDER_APP_NAME"
        android:usesCleartextTraffic="false">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden"
            android:screenOrientation="portrait">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`);

  // MainActivity.java - ASCII only, no special chars
  fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/java/com/coactiv/push/MainActivity.java'),
`package com.coactiv.push;

import android.app.Activity;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.PermissionRequest;
import android.net.Uri;
import android.content.Intent;
import android.os.Build;

public class MainActivity extends Activity {
    private WebView webView;
    private static final String TARGET_URL = "PLACEHOLDER_URL";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(0xFF1a1a2e);
        }
        webView = new WebView(this);
        setContentView(webView);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " CoActiv-App/1.0");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.contains("co-activ.netlify.app")) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    request.grant(request.getResources());
                }
            }
        });
        webView.loadUrl(TARGET_URL);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
`);

  // styles.xml
  fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/res/values/styles.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="android:Theme.Material.Light.NoActionBar">
        <item name="android:colorPrimary">#1a1a2e</item>
        <item name="android:colorPrimaryDark">#0f0f1a</item>
        <item name="android:colorAccent">#16a34a</item>
    </style>
</resources>`);

  // network_security_config.xml
  fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/res/xml/network_security_config.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="true">co-activ.netlify.app</domain>
    </domain-config>
</network-security-config>`);

  // Download the REAL Co-Activ icon from Netlify
  let icon;
  try {
    console.log('Downloading Co-Activ icon from Netlify...');
    icon = await downloadIcon('https://co-activ.netlify.app/icon.png');
    console.log(`Icon downloaded: ${icon.length} bytes`);
  } catch (err) {
    console.warn('Failed to download icon, using fallback:', err.message);
    icon = createFallbackIcon();
  }

  ['mipmap-hdpi','mipmap-mdpi','mipmap-xhdpi','mipmap-xxhdpi','mipmap-xxxhdpi'].forEach(d => {
    fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/res', d, 'ic_launcher.png'), icon);
  });

  console.log('Template ready');
}

// Fallback icon only used if download fails
function createFallbackIcon() {
  const zlib = require('zlib');
  const w = 48, h = 48;
  function crc32(buf) {
    let t = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([l, td, c]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = [];
  for (let y = 0; y < h; y++) { raw.push(0); for (let x = 0; x < w; x++) raw.push(0x16, 0xa3, 0x4a); }
  const comp = zlib.deflateSync(Buffer.from(raw));
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr), chunk('IDAT', comp), chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { generateTemplate, ANDROID_DIR, TEMPLATE_DIR };
