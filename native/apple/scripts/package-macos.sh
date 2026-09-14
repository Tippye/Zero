#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${ZERO_MAC_VERSION:-1.0.1}"
BUILD_NUMBER="${ZERO_MAC_BUILD_NUMBER:-2}"
SIGNING="${ZERO_MAC_SIGNING:-unsigned}"
TEAM_ID="${ZERO_MAC_TEAM_ID:-}"
NOTARY_PROFILE="${ZERO_MAC_NOTARY_PROFILE:-}"
RELEASE_DIR="$ROOT/release"
WORK_DIR="$ROOT/.derived/release-macos"
ARCHIVE="$WORK_DIR/ZeroMac.xcarchive"
EXPORT_DIR="$WORK_DIR/export"
STAGE_DIR="$WORK_DIR/dmg"
ZIP_PATH="$RELEASE_DIR/Zero-Mail-$VERSION-macos-universal.zip"
DMG_PATH="$RELEASE_DIR/Zero-Mail-$VERSION-macos-universal.dmg"
CHECKSUM_PATH="$RELEASE_DIR/SHA256SUMS-$VERSION.txt"

if [ "$(uname -s)" != "Darwin" ] || ! command -v xcodebuild >/dev/null 2>&1; then
  echo "This release must be built on macOS with Xcode selected." >&2
  exit 1
fi

case "$SIGNING" in
  unsigned|developer-id) ;;
  *)
    echo "ZERO_MAC_SIGNING must be unsigned or developer-id." >&2
    exit 1
    ;;
esac

if [ "$SIGNING" = "developer-id" ] && [ -z "$TEAM_ID" ]; then
  echo "ZERO_MAC_TEAM_ID is required for Developer ID signing." >&2
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$RELEASE_DIR" "$WORK_DIR"
rm -f "$ZIP_PATH" "$DMG_PATH" "$CHECKSUM_PATH"

cd "$ROOT"
swift test --configuration release --scratch-path "$WORK_DIR/swift"

archive_args=(
  -project ZeroMail.xcodeproj
  -scheme ZeroMac
  -configuration Release
  -destination "generic/platform=macOS"
  -archivePath "$ARCHIVE"
  MARKETING_VERSION="$VERSION"
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER"
  ONLY_ACTIVE_ARCH=NO
  'ARCHS=arm64 x86_64'
  archive
)

if [ "$SIGNING" = "unsigned" ]; then
  xcodebuild "${archive_args[@]}" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
  APP_PATH="$ARCHIVE/Products/Applications/ZeroMac.app"
else
  xcodebuild -allowProvisioningUpdates "${archive_args[@]}" DEVELOPMENT_TEAM="$TEAM_ID"
  EXPORT_OPTIONS="$WORK_DIR/ExportOptions.plist"
  cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>destination</key><string>export</string>
  <key>method</key><string>developer-id</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$TEAM_ID</string>
</dict></plist>
PLIST
  xcodebuild -allowProvisioningUpdates -exportArchive \
    -archivePath "$ARCHIVE" -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_OPTIONS"
  APP_PATH="$EXPORT_DIR/ZeroMac.app"
fi

if [ ! -d "$APP_PATH" ]; then
  echo "Expected application not found: $APP_PATH" >&2
  exit 1
fi

INFO_PLIST="$APP_PATH/Contents/Info.plist"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")" = "$VERSION"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO_PLIST")" = "$BUILD_NUMBER"

ARCHS="$(lipo -archs "$APP_PATH/Contents/MacOS/ZeroMac")"
case " $ARCHS " in *" arm64 "*) ;; *) echo "arm64 slice is missing" >&2; exit 1;; esac
case " $ARCHS " in *" x86_64 "*) ;; *) echo "x86_64 slice is missing" >&2; exit 1;; esac

if [ "$SIGNING" = "developer-id" ]; then
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  if [ -n "$NOTARY_PROFILE" ]; then
    NOTARY_ZIP="$WORK_DIR/notary-upload.zip"
    ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$NOTARY_ZIP"
    xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP_PATH"
    xcrun stapler validate "$APP_PATH"
  else
    echo "Developer ID signature created without notarization (ZERO_MAC_NOTARY_PROFILE is unset)." >&2
  fi
fi

ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"
mkdir -p "$STAGE_DIR"
ditto "$APP_PATH" "$STAGE_DIR/Zero Mail.app"
ln -s /Applications "$STAGE_DIR/Applications"
hdiutil create -volname "Zero Mail $VERSION" -srcfolder "$STAGE_DIR" \
  -ov -format UDZO "$DMG_PATH"

if [ "$SIGNING" = "developer-id" ] && [ -n "$NOTARY_PROFILE" ]; then
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
  spctl --assess --type execute --verbose=2 "$APP_PATH"
fi

(
  cd "$RELEASE_DIR"
  shasum -a 256 "$(basename "$ZIP_PATH")" "$(basename "$DMG_PATH")" > "$(basename "$CHECKSUM_PATH")"
)

echo "macOS release created:"
echo "  $ZIP_PATH"
echo "  $DMG_PATH"
echo "  $CHECKSUM_PATH"
echo "  signing: $SIGNING"
echo "  architectures: $ARCHS"
