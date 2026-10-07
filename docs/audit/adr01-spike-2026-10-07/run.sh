#!/bin/bash
# Usage: run.sh <variant>. Starts a loopback TCP+UDP listener, runs the probe unsandboxed (control),
# then the spike host (XPC -> sandboxed supervisor -> java/node/probe), and prints what the listener saw.
HERE="$(cd "$(dirname "$0")" && pwd)"; V="$1"; APP="$HERE/out-$V/Spike.app"
LOG="$HERE/listener-$V.log"; rm -f "$LOG" "$HERE/write-target-$V"
/opt/homebrew/bin/node -e '
const net=require("net"),dgram=require("dgram"),fs=require("fs");const log=m=>fs.appendFileSync(process.argv[1],m+"\n");
const t=net.createServer(s=>{let d="";s.on("data",c=>d+=c);s.on("close",()=>log("tcp:"+(d||"<no-payload>")))}).listen(0,"127.0.0.1",()=>{const p=t.address().port;
const u=dgram.createSocket("udp4");u.on("message",m=>log("udp:"+m));u.bind(p,"127.0.0.1",()=>{fs.writeFileSync(process.argv[1]+".port",String(p))});});
setTimeout(()=>process.exit(0),60000);' "$LOG" & LP=$!
for i in $(seq 1 50); do [ -s "$LOG.port" ] && break; sleep 0.1; done; PORT=$(cat "$LOG.port")
echo "== control (unsandboxed probe, same args)"; "$APP/Contents/XPCServices/Supervisor.xpc/Contents/Resources/spike/probe" "$HERE/sentinel.txt" "$HERE/write-target-$V" "$PORT" control
echo "listener after control: $(sort "$LOG" 2>/dev/null | uniq -c | tr '\n' ' ')"; : > "$LOG"
echo "== spike host"; "$APP/Contents/MacOS/spike-host" "$HERE/sentinel.txt" "$HERE/write-target-$V" "$PORT"; echo "host exit $?"
sleep 1; echo "listener after sandboxed run: $(sort "$LOG" | uniq -c | tr '\n' ' ')"; ls "$HERE/write-target-$V" 2>/dev/null && echo "WRITE TARGET EXISTS"
kill $LP 2>/dev/null; rm -f "$LOG.port"
