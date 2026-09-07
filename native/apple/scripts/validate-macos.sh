#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Run this script on macOS with Xcode selected.' >&2
  exit 1
fi
xcodebuild -version
swift test
xcodebuild -project ZeroMail.xcodeproj -scheme ZeroMac -destination 'platform=macOS' -derivedDataPath .derived/mac CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ZeroMail.xcodeproj -scheme ZeroIOS -destination 'generic/platform=iOS Simulator' -derivedDataPath .derived/ios CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ZeroMail.xcodeproj -scheme ZeroWatch -destination 'generic/platform=watchOS Simulator' -derivedDataPath .derived/watch CODE_SIGNING_ALLOWED=NO build
echo 'Builds passed. Run the simulator and device acceptance checklist in MIGRATION.zh-CN.md.'
