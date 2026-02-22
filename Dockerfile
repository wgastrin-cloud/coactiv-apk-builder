FROM node:18-bullseye

# Installer Java JDK headless + outils Android
RUN apt-get update && apt-get install -y \
    openjdk-11-jdk-headless \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Variables Android SDK
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${PATH}:${ANDROID_HOME}/build-tools/33.0.2"

# Installer Android build-tools (léger ~150 Mo)
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    cd ${ANDROID_HOME}/cmdline-tools && \
    wget -q "https://dl.google.com/android/repository/commandlinetools-linux-10406996_latest.zip" -O tools.zip && \
    unzip -q tools.zip && \
    mv cmdline-tools latest && \
    rm tools.zip && \
    yes | ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null 2>&1 && \
    ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager "build-tools;33.0.2" "platforms;android-33" --sdk_root=${ANDROID_HOME}

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p apks builds keystore

# Générer le keystore de signature
RUN keytool -genkeypair -v \
    -keystore keystore/coactiv.keystore \
    -alias coactiv \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass coactiv123 -keypass coactiv123 \
    -dname "CN=Co-Activ, OU=Push, O=Co-Activ, L=Lyon, ST=Rhone, C=FR" 2>/dev/null || true

EXPOSE 3000

CMD ["node", "server.js"]
