FROM node:18-bullseye

RUN apt-get update && \
    apt-get install -y wget unzip zip && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/java && \
    cd /opt/java && \
    wget -q "https://download.oracle.com/java/17/archive/jdk-17.0.12_linux-x64_bin.tar.gz" -O jdk.tar.gz && \
    tar xzf jdk.tar.gz && \
    rm jdk.tar.gz

ENV JAVA_HOME=/opt/java/jdk-17.0.12
ENV PATH="${JAVA_HOME}/bin:${PATH}"

ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${PATH}:${ANDROID_HOME}/build-tools/33.0.2:${ANDROID_HOME}/cmdline-tools/latest/bin"

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    cd ${ANDROID_HOME}/cmdline-tools && \
    wget -q "https://dl.google.com/android/repository/commandlinetools-linux-10406996_latest.zip" -O tools.zip && \
    unzip -q tools.zip && \
    mv cmdline-tools latest && \
    rm tools.zip

RUN yes | sdkmanager --licenses --sdk_root=${ANDROID_HOME} > /dev/null 2>&1 || true

RUN sdkmanager "build-tools;33.0.2" "platforms;android-33" --sdk_root=${ANDROID_HOME}

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p apks builds keystore

RUN keytool -genkeypair -v \
    -keystore keystore/coactiv.keystore \
    -alias coactiv \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass coactiv123 -keypass coactiv123 \
    -dname "CN=Co-Activ, OU=Push, O=Co-Activ, L=Lyon, ST=Rhone, C=FR" 2>/dev/null || true

EXPOSE 3000

CMD ["node", "server.js"]
