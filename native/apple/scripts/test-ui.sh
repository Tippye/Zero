#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Usage: test-ui.sh ZeroIOS 'platform=iOS Simulator,id=…' [evidence-directory]
scheme="${1:-ZeroMac}"
destination="${2:-platform=macOS}"
evidence="${3:-$PWD/.derived/ui-${scheme}}"
mkdir -p "$evidence"
build_directory="${ZERO_UI_BUILD_DIR:-$evidence/build}"
if ! curl -fsS http://localhost:19280/__test/state >/dev/null; then
  node scripts/ui-fixture.mjs >"$evidence/fixture.log" 2>&1 &
  fixture_pid=$!
  trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
  for attempt in {1..50}; do
    if curl -fsS http://localhost:19280/__test/state >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
fi
signing=(CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES)
if [[ "$scheme" == ZeroMac && -z "${ZERO_DEVELOPMENT_TEAM:-}" ]]; then
  # App Group provisioning requires an Apple development certificate. Preserve
  # the app sandbox for local functional tests, but omit the group entitlement.
  # Widget/Share group access must be tested separately with a provisioned build.
  python3 - "$PWD/Configuration/macOS.entitlements" "$evidence/ui-test.entitlements" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as source: data = plistlib.load(source)
data.pop('com.apple.security.application-groups', None)
with open(sys.argv[2], 'wb') as target: plistlib.dump(data, target)
PY
  signing+=("CODE_SIGN_ENTITLEMENTS=$evidence/ui-test.entitlements")
elif [[ -n "${ZERO_DEVELOPMENT_TEAM:-}" ]]; then
  signing=("DEVELOPMENT_TEAM=$ZERO_DEVELOPMENT_TEAM" CODE_SIGNING_ALLOWED=YES)
fi
xcodebuild -project ZeroMail.xcodeproj -scheme "$scheme" -destination "$destination" \
  -derivedDataPath "$build_directory" "${signing[@]}" \
  -parallel-testing-enabled NO build-for-testing >"$evidence/build.log" 2>&1
python3 - "$build_directory/Build/Products" "$evidence/tests.xctestrun" <<'PY'
import pathlib, plistlib, sys
source = next(pathlib.Path(sys.argv[1]).glob('*.xctestrun'))
data = plistlib.loads(source.read_bytes())
def update(value):
    if isinstance(value, dict):
        if 'TestBundlePath' in value:
            value.setdefault('EnvironmentVariables', {})['ZERO_UI_FIXTURE'] = '1'
        for child in value.values(): update(child)
    elif isinstance(value, list):
        for child in value: update(child)
update(data)
# __TESTROOT__ resolves relative to the xctestrun location. Keep the run next to
# its compiled products so paths remain valid on both Mac and Simulator.
source.write_bytes(plistlib.dumps(data))
pathlib.Path(sys.argv[2]).write_text(str(source))
PY
test_run="$(cat "$evidence/tests.xctestrun")"
selection=(test-without-building)
if [[ -n "${ZERO_UI_ONLY_TESTING:-}" ]]; then
  selection+=("-only-testing:$ZERO_UI_ONLY_TESTING")
fi
xcodebuild -xctestrun "$test_run" -destination "$destination" \
  -resultBundlePath "$evidence/results.xcresult" -parallel-testing-enabled NO \
  "${selection[@]}" >"$evidence/tests.log" 2>&1
echo "UI tests passed. Evidence: $evidence/results.xcresult"
