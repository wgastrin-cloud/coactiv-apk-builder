#!/usr/bin/env node
/**
 * generate-template.js
 * Génère le template APK de base une seule fois au démarrage.
 * Ensuite, chaque APK est créé en modifiant l'URL dans le template.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, 'template');
const ANDROID_DIR = path.join(TEMPLATE_DIR, 'android-project');

function generateTemplate() {
  console.log('📦 Génération du template Android...');

  // Structure du projet Android minimal
  const dirs = [
    'app/src/main/java/com/coactiv/push',
    'app/src/main/res/values',
    'app/src/main/res/mipmap-hdpi',
    'app/src/main/res/mipmap-mdpi',
    'app/src/main/res/mipmap-xhdpi',
    'app/src/main/res/mipmap-xxhdpi',
    'app/src/main/res/mipmap-xxxhdpi',
    'app/src/main/res/xml',
    'gradle/wrapper'
  ];

  dirs.forEach(d => {
    fs.mkdirSync(path.join(ANDROID_DIR, d), { recursive: true });
  });

  // build.gradle (project level)
  fs.writeFileSync(path.join(ANDROID_DIR, 'build.gradle'), `
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:7.4.2'
    }
}
allprojects {
    repositories {
        google()
        mavenCentral()
    }
}
task clean(type: Delete) {
    delete rootProject.buildDir
}
`);

  // settings.gradle
  fs.writeFileSync(path.join(ANDROID_DIR, 'settings.gradle'), `
rootProject.name = "CoActiv"
include ':app'
`);

  // gradle.properties
  fs.writeFileSync(path.join(ANDROID_DIR, 'gradle.properties'), `
android.useAndroidX=true
org.gradle.jvmargs=-Xmx512m
`);

  // gradle-wrapper.properties
  fs.writeFileSync(path.join(ANDROID_DIR, 'gradle/wrapper/gradle-wrapper.properties'), `
distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-7.6.3-bin.zip
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`);

  // app/build.gradle
  fs.writeFileSync(path.join(ANDROID_DIR, 'app/build.gradle'), `
apply plugin: 'com.android.application'

android {
    namespace 'com.coactiv.push'
    compileSdkVersion 33
    
    defaultConfig {
        applicationId "PLACEHOLDER_PACKAGE_ID"
        minSdkVersion 21
        targetSdkVersion 33
        versionCode 1
        versionName "1.0"
    }
    
    buildTypes {
        release {
            minifyEnabled false
        }
    }
    
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
}

dependencies {
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'androidx.webkit:webkit:1.7.0'
}
`);

  // AndroidManifest.xml
  fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/AndroidManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="PLACEHOLDER_PACKAGE_ID">
    
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="PLACEHOLDER_APP_NAME"
        android:supportsRtl="true"
        android:theme="@style/AppTheme"
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

  // MainActivity.java
  fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/java/com/coactiv/push/MainActivity.java'), `package com.coactiv.push;

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
    private static final String URL = "PLACEHOLDER_URL";
    
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Plein ecran
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        
        // Status bar
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(0xFF1a1a2e);
        }
        
        webView = new WebView(this);
        setContentView(webView);
        
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        
        // User Agent custom
        String ua = settings.getUserAgentString();
        settings.setUserAgentString(ua + " CoActiv-App/1.0");
        
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.contains("co-activ.netlify.app")) {
                    return false; // Reste dans l'app
                }
                // Liens externes - ouvrir dans le navigateur
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(intent);
                return true;
            }
        });
        
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Accept permissions
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    request.grant(request.getResources());
                }
            }
        });
        
        webView.loadUrl(URL);
    }
    
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
`);

  // styles.xml
  fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/res/values/styles.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="android:Theme.Material.Light.NoActionBar">
        <item name="android:colorPrimary">#1a1a2e</item>
        <item name="android:colorPrimaryDark">#0f0f1a</item>
        <item name="android:colorAccent">#16a34a</item>
        <item name="android:windowBackground">#f5f5f5</item>
    </style>
</resources>`);

  // network_security_config.xml
  fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/res/xml/network_security_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="true">co-activ.netlify.app</domain>
    </domain-config>
</network-security-config>`);

  // Icône par défaut (48x48 PNG vert avec "C")
  const defaultIcon = createDefaultIcon();
  ['mipmap-hdpi', 'mipmap-mdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'].forEach(d => {
    fs.writeFileSync(path.join(ANDROID_DIR, 'app/src/main/res', d, 'ic_launcher.png'), defaultIcon);
  });

  console.log('✅ Template Android créé');
}

// Créer un PNG minimal valide (1x1 pixel vert)
function createDefaultIcon() {
  // PNG minimal 48x48 vert (#16a34a)
  const width = 48, height = 48;
  
  // Construction manuelle d'un PNG
  function crc32(buf) {
    let c, crcTable = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT - raw image data (green pixels)
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter none
    for (let x = 0; x < width; x++) {
      rawData.push(0x16, 0xa3, 0x4a); // #16a34a green
    }
  }
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(Buffer.from(rawData));

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = chunk('IHDR', ihdr);
  const idatChunk = chunk('IDAT', compressed);
  const iendChunk = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

module.exports = { generateTemplate, ANDROID_DIR, TEMPLATE_DIR };

if (require.main === module) {
  generateTemplate();
}
