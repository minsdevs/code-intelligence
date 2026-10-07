#!/bin/bash
# ADR-01 T03 spike: assemble an ad-hoc-signed app with an App Sandbox XPC supervisor.
# Usage: build.sh <candidate.app> <variant: plain|inherit>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; CAND="$1"; VARIANT="$2"
APP="$HERE/out-$VARIANT/Spike.app"; C="$APP/Contents"; X="$C/XPCServices/Supervisor.xpc/Contents"
rm -rf "$HERE/out-$VARIANT"; mkdir -p "$C/MacOS" "$X/MacOS" "$X/Resources/spike" "$X/Resources/runtime" "$X/Frameworks"
plist() { /usr/bin/plutil -create xml1 "$1"; shift; while [ $# -gt 0 ]; do /usr/bin/plutil -insert "$1" -string "$2" "$P"; shift 2; done; }
P="$C/Info.plist"; plist "$P" CFBundleIdentifier dev.codeintelligence.spike.adr01 CFBundleExecutable spike-host CFBundlePackageType APPL CFBundleName Spike
P="$X/Info.plist"; plist "$P" CFBundleIdentifier dev.codeintelligence.spike.adr01.supervisor CFBundleExecutable Supervisor CFBundlePackageType XPC! CFBundleName Supervisor
/usr/bin/plutil -insert XPCService -dictionary "$P"; /usr/bin/plutil -insert XPCService.ServiceType -string Application "$P"
SDK="$(xcrun --show-sdk-path)"
clang -O1 -isysroot "$SDK" -o "$C/MacOS/spike-host" "$HERE/src/host.c"
clang -O1 -isysroot "$SDK" -o "$X/MacOS/Supervisor" "$HERE/src/supervisor.c"
clang -O1 -isysroot "$SDK" -o "$X/Resources/spike/probe" "$HERE/src/probe.c"
/opt/homebrew/opt/openjdk/bin/javac --release 21 -d "$X/Resources/spike" "$HERE/src/Count.java"
cp "$HERE/src/node-analyze.cjs" "$X/Resources/spike/"
# Read-only candidate inputs, APFS clones (no extra disk until rewritten).
/bin/cp -cR "$CAND/Contents/Resources/runtime/jre" "$X/Resources/runtime/jre"
/bin/cp -cR "$CAND/Contents/Resources/runtime/ts-analyzer" "$X/Resources/runtime/ts-analyzer"
for f in "Electron Framework" Mantle ReactiveObjC Squirrel; do /bin/cp -cR "$CAND/Contents/Frameworks/$f.framework" "$X/Frameworks/"; done
/bin/cp -c "$CAND/Contents/MacOS/Code Intelligence Validation" "$X/MacOS/"
ENT="$HERE/ent"; mkdir -p "$ENT"
cat > "$ENT/sandbox.plist" <<P1
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>
P1
cat > "$ENT/inherit.plist" <<P2
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.inherit</key><true/></dict></plist>
P2
cat > "$ENT/inherit-jit.plist" <<P3
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.inherit</key><true/>
<key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>
P3
codesign --force --sign - "$X/Resources/spike/probe"
if [ "$VARIANT" = inherit ]; then
  codesign --force --sign - --entitlements "$ENT/inherit.plist" "$X/Resources/spike/probe"
  codesign --force --sign - --options runtime --entitlements "$ENT/inherit-jit.plist" "$X/Resources/runtime/jre/bin/java"
  codesign --force --sign - --options runtime --entitlements "$ENT/inherit-jit.plist" "$X/MacOS/Code Intelligence Validation"
fi
codesign --force --sign - --options runtime --entitlements "$ENT/sandbox.plist" "$C/XPCServices/Supervisor.xpc"
codesign --force --sign - "$C/MacOS/spike-host"
codesign --force --sign - "$APP"
echo "built $APP"
