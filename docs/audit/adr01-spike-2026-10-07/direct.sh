#!/bin/bash
# Runs the worker binaries directly (no sandboxed parent) with ELECTRON_RUN_AS_NODE=1.
HERE="$(cd "$(dirname "$0")" && pwd)"
for V in plain inherit; do
  X="$HERE/out-$V/Spike.app/Contents/XPCServices/Supervisor.xpc/Contents"
  env -i HOME="$HOME" PATH=/usr/bin:/bin ELECTRON_RUN_AS_NODE=1 "$X/MacOS/Code Intelligence Validation" -e 'console.log("node ran unsandboxed, home entries=" + require("fs").readdirSync(require("os").homedir()).length)' >"$HERE/direct-$V.out" 2>&1; echo "$V electron-node direct: exit=$? $(head -c 160 "$HERE/direct-$V.out")"
  "$X/Resources/runtime/jre/bin/java" -version >"$HERE/direct-java-$V.out" 2>&1; echo "$V java direct: exit=$? $(head -1 "$HERE/direct-java-$V.out")"
done
