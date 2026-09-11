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
  # A simulator shell needs neither an Apple team nor a distribution identity.
  workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)"
  scheme="$(basename "$workspace" .xcworkspace)"
  xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$build_dir/native-build" CODE_SIGNING_ALLOWED=NO build
  find "$build_dir/native-build/Build/Products/Release-iphonesimulator" -maxdepth 1 -name '*.app' > "$build_dir/native-artifact.txt"
else
  # Expo's release template uses a disposable debug keystore locally. This APK
  # embeds the release Hermes bundle; it is never a Play Store artifact.
  (cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon)
  find "$build_dir/android/app/build/outputs/apk/release" -maxdepth 1 -name '*.apk' > "$build_dir/native-artifact.txt"
fi
test "$(wc -l < "$build_dir/native-artifact.txt" | tr -d ' ')" = 1
test -e "$(cat "$build_dir/native-artifact.txt")"
echo "Native acceptance shell built: $platform"
