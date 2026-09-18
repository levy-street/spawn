#!/usr/bin/env bash
set -euo pipefail

platform="${1:?Usage: build-native-acceptance.sh ios|android NEW_DIRECTORY}"
build_dir="${2:?A new disposable build directory is required}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export CI=1 EXPO_NO_TELEMETRY=1 EXPO_NO_CAPABILITY_SYNC=1
node "$script_dir/prepare-native-acceptance.mjs" "$build_dir" "$platform"
cd "$build_dir"
npx tsc --noEmit --project native-acceptance-tsconfig.json
npx expo prebuild --platform "$platform" --no-install
if [[ "$platform" == ios ]]; then
  (cd ios && pod install)
  # Xcode embeds simulator entitlements during linking. Disabling signing also
  # skips that work and makes real SecureStore writes fail with -34018. The "-"
  # identity signs locally without an Apple team, certificate or profile.
  workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)"
  scheme="$(basename "$workspace" .xcworkspace)"
  xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$build_dir/native-build" CODE_SIGNING_ALLOWED=YES \
    CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
    PROVISIONING_PROFILE_SPECIFIER= build
  find "$build_dir/native-build/Build/Products/Release-iphonesimulator" -maxdepth 1 -name '*.app' > "$build_dir/native-artifact.txt"
else
  # Expo's release template uses a disposable debug keystore locally. This APK
  # embeds the release Hermes bundle; it is never a Play Store artifact.
  # Release lint exhausted the template's 512 MiB metaspace limit in hosted CI.
  # Keep its 2 GiB heap, allow 1 GiB metaspace, and fail promptly on another OOM.
  (cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64 \
    '-Dorg.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m -XX:+ExitOnOutOfMemoryError' \
    --no-daemon)
  find "$build_dir/android/app/build/outputs/apk/release" -maxdepth 1 -name '*.apk' > "$build_dir/native-artifact.txt"
fi
test "$(wc -l < "$build_dir/native-artifact.txt" | tr -d ' ')" = 1
test -e "$(cat "$build_dir/native-artifact.txt")"
if [[ "$platform" == ios ]]; then
  app="$(cat "$build_dir/native-artifact.txt")"
  codesign --verify --strict "$app"
  # Simulator entitlements live in the executable's Mach-O sections, not its
  # macOS code signature. Check both plist and DER sections before installation.
  python3 - "$app" <<'PY'
import pathlib
import plistlib
import subprocess
import sys

app = pathlib.Path(sys.argv[1])
info = plistlib.loads((app / "Info.plist").read_bytes())
if info["CFBundleIdentifier"] != "dev.spawnd.acceptance":
    raise SystemExit("Refusing a non-acceptance simulator app")
binary = app / info["CFBundleExecutable"]
sections = subprocess.check_output(["xcrun", "otool", "-l", str(binary)], text=True)
for name in ("__entitlements", "__ents_der"):
    if f"sectname {name}\n" not in sections:
        raise SystemExit(f"Simulator executable lacks embedded {name}")
print("Verified local simulator signature and embedded entitlement sections")
PY
fi
echo "Native acceptance shell built: $platform"
