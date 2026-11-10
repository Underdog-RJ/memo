#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
port="${1:-4317}"
if ! [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
  echo "用法：./macos/build.sh [Memo 服务端口]" >&2
  exit 2
fi
output="$root/build/Memo.app"
staging="$(mktemp -d)"
trap 'rm -r "$staging"' EXIT
app="$staging/Memo.app"
mkdir -p "$app/Contents/MacOS"
xcrun clang -O2 -Wall -Wextra -fobjc-arc -mmacosx-version-min=13.0 \
  -framework AppKit "$root/macos/MemoMenu.m" -o "$app/Contents/MacOS/Memo"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.memo.menubar</string>
  <key>CFBundleName</key><string>Memo</string>
  <key>CFBundleDisplayName</key><string>Memo</string>
  <key>CFBundleExecutable</key><string>Memo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>MemoPort</key><integer>$port</integer>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
# Sign before copying into the project, which may be in a synced Desktop folder.
codesign --force --sign - "$app"
mkdir -p "$root/build"
ditto --norsrc --noextattr "$app" "$output"
printf '%s\n' "$output"
