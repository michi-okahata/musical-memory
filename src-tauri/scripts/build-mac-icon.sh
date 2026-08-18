#!/bin/bash
# Compile flow.icon into the layered asset catalog macOS 26 needs for the
# Liquid Glass app icon. Run after editing flow.icon in Icon Composer.
#
# Produces icons/mac/Assets.car (the layered icon, with light/dark/tinted
# variants) and icons/mac/flow.icns (flat fallback for older macOS).
# tauri.conf.json copies both into Contents/Resources at bundle time, and
# Info.plist points CFBundleIconName at them.
set -euo pipefail

# actool resolves relative inputs against its own working directory, not the
# shell's, so everything below is absolute.
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/flow.icon"
out="$root/icons/mac"

[ -d "$src" ] || { echo "missing $src" >&2; exit 1; }
mkdir -p "$out"

xcrun actool \
  --output-format human-readable-text \
  --notices --warnings \
  --app-icon flow \
  --include-all-app-icons \
  --output-partial-info-plist "$out/partial.plist" \
  --target-device mac \
  --minimum-deployment-target 26.0 \
  --platform macosx \
  --compile "$out" \
  "$src"

rm -f "$out/partial.plist"

# actool exits 0 even when the icon fails to export, so check the artefacts.
for f in Assets.car flow.icns; do
  [ -s "$out/$f" ] || { echo "actool did not produce $f" >&2; exit 1; }
done
echo "built $out/Assets.car and $out/flow.icns"
