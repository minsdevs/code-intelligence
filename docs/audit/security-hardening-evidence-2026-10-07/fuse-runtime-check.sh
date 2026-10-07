#!/bin/bash
for label in original flipped; do
  if [ $label = original ]; then BIN="$1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"; else BIN="$2/Electron.app/Contents/MacOS/Electron"; fi
  rm -f "$2/mark-$label"
  out=$(env -i HOME="$HOME" PATH=/usr/bin:/bin ELECTRON_RUN_AS_NODE=1 MARK="$2/mark-$label" NODE_OPTIONS="--require $2/marker.cjs" "$BIN" -e 'console.log("node-mode " + process.versions.node)' 2>&1 | tail -1)
  insp=$(env -i HOME="$HOME" PATH=/usr/bin:/bin ELECTRON_RUN_AS_NODE=1 /usr/bin/perl -e 'alarm 8; exec @ARGV' "$BIN" --inspect=0 -e 'console.log("inspector=" + (require("inspector").url() ? "listening" : "off"))' 2>&1 | grep -E "inspector=|Debugger listening" | head -2 | tr '\n' ' ')
  echo "$label: run=$out NODE_OPTIONS_marker=$([ -e "$2/mark-$label" ] && echo ran || echo absent) inspect: $insp"
done
