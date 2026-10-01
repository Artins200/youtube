#!/usr/bin/env bash
# Собирает устанавливаемый APK без Gradle: JDK 17 + Android SDK platform 33/build-tools.
# При отсутствии apksigner возможна подпись через npm ci --prefix tools (v1 + v2 + v3).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
BT="${BUILD_TOOLS:-$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)}"
AAPT2="${AAPT2:-$BT/aapt2}"
ZIPALIGN="${ZIPALIGN:-$BT/zipalign}"
ANDROID_JAR="${ANDROID_JAR:-$SDK/platforms/android-33/android.jar}"
APKSIGNER="${APKSIGNER:-$BT/apksigner}"
D8="${D8:-$BT/d8}"
JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
JAR="${JAVA_HOME:+$JAVA_HOME/bin/}jar"
APK_OUT="${APK_OUT:-$ROOT/release/YouTube-Local.apk}"
SIGN_DIR="${APK_SIGN_DIR:-$HOME/.apk-signing/youtube-local}"
APK_KEY="${APK_KEY:-$SIGN_DIR/developer.key.pem}"
APK_CERT="${APK_CERT:-$SIGN_DIR/developer.cert.pem}"

for program in "$JAVA" "$JAVAC" "$JAR" "$AAPT2" "$ZIPALIGN"; do
  if ! command -v "$program" >/dev/null 2>&1; then
    echo "Не найдена программа: $program (задайте JAVA_HOME, ANDROID_HOME или BUILD_TOOLS)" >&2
    exit 1
  fi
done
if [[ ! -f "$ANDROID_JAR" ]]; then
  echo "Не найдена платформа Android 33: $ANDROID_JAR" >&2
  exit 1
fi
if [[ ! -x "$D8" && -z "${DX_JAR:-}" ]]; then
  echo "Не найден d8: $D8 (можно задать DX_JAR для старого dx.jar)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/classes" "$TMP/assets/www/icons" "$(dirname "$APK_OUT")"

"$AAPT2" compile --dir "$ROOT/android/app/src/main/res" -o "$TMP/resources.zip"
"$AAPT2" link -o "$TMP/base.apk" -I "$ANDROID_JAR" \
  --manifest "$ROOT/android/app/src/main/AndroidManifest.xml" "$TMP/resources.zip"

"$JAVAC" -encoding UTF-8 --release 8 -cp "$ANDROID_JAR" -d "$TMP/classes" \
  "$ROOT"/android/app/src/main/java/app/ytlocal/player/*.java
if [[ -n "${DX_JAR:-}" ]]; then
  "$JAVA" -cp "$DX_JAR" com.android.dx.command.Main --dex --min-sdk-version=24 \
    --output="$TMP/classes.dex" "$TMP/classes"
else
  "$JAR" cf "$TMP/classes.jar" -C "$TMP/classes" .
  mkdir -p "$TMP/dex"
  "$D8" --min-api 24 --lib "$ANDROID_JAR" --output "$TMP/dex" "$TMP/classes.jar"
  mv "$TMP/dex/classes.dex" "$TMP/classes.dex"
fi

# Точно перечисляем файлы внутри APK (serve.py и другие скрипты туда не попадают).
for name in index.html styles.css app.js db.js media.js youtube.js native.js sw.js manifest.webmanifest; do
  cp "$ROOT/app/$name" "$TMP/assets/www/$name"
done
cp "$ROOT"/app/icons/*.png "$TMP/assets/www/icons/"
mkdir -p "$TMP/assets/www/fonts"
cp "$ROOT"/app/fonts/* "$TMP/assets/www/fonts/"
(cd "$TMP" && zip -q -0 -j base.apk classes.dex && zip -qr base.apk assets)
"$ZIPALIGN" -f -p 4 "$TMP/base.apk" "$TMP/aligned.apk"

if [[ ! -f "$APK_KEY" || ! -f "$APK_CERT" ]]; then
  mkdir -p "$(dirname "$APK_KEY")" "$(dirname "$APK_CERT")"
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -keyout "$APK_KEY" -out "$APK_CERT" -subj '/CN=YouTube Local developer build/' >/dev/null 2>&1
  chmod 600 "$APK_KEY"
  echo "Создан тестовый ключ: $APK_KEY (для обновлений сохраните его вне Git)"
fi
SIGNED_APK="$TMP/signed.apk"
if [[ -x "$APKSIGNER" ]]; then
  # Android SDK apksigner требует бинарный PKCS#8, а запасной Node-подписыватель — PEM.
  SIGN_KEY="$APK_KEY"
  if grep -q -- '-----BEGIN' "$APK_KEY"; then
    openssl pkcs8 -topk8 -nocrypt -in "$APK_KEY" -outform DER -out "$TMP/signing-key.pk8"
    chmod 600 "$TMP/signing-key.pk8"
    SIGN_KEY="$TMP/signing-key.pk8"
  fi
  "$APKSIGNER" sign --key "$SIGN_KEY" --cert "$APK_CERT" \
    --out "$SIGNED_APK" "$TMP/aligned.apk"
  "$APKSIGNER" verify --verbose "$SIGNED_APK"
elif [[ -d "$ROOT/tools/node_modules/apk_sign_ts" ]]; then
  ZIPALIGN="$ZIPALIGN" node "$ROOT/tools/sign-apk.mjs" "$TMP/aligned.apk" "$SIGNED_APK" "$APK_KEY" "$APK_CERT"
  "$ZIPALIGN" -c 4 "$SIGNED_APK"
  "${JAVA_HOME:+$JAVA_HOME/bin/}jarsigner" -verify "$SIGNED_APK" | grep 'jar verified' || {
    echo 'Ошибка проверки JAR-подписи APK' >&2; exit 1;
  }
else
  echo 'Нет apksigner. Установите Android build-tools или выполните npm ci --prefix tools.' >&2
  exit 1
fi
"$ZIPALIGN" -c 4 "$SIGNED_APK"
mv "$SIGNED_APK" "$APK_OUT"
"$AAPT2" dump badging "$APK_OUT" | grep -E '^(package:|application-label:|launchable-activity:|sdkVersion:|targetSdkVersion:)' || true
sha256sum "$APK_OUT"
echo "Готовый APK: $APK_OUT"
