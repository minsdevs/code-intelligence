'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { verifyControlRuntime } = require('../control-runtime.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function crc32(data) { let v = 0xffffffff; for (const b of data) { v ^= b; for (let i=0;i<8;i++) v=(v>>>1)^((v&1)?0xedb88320:0); } return (v^0xffffffff)>>>0; }
function zip(items) {
  const locals=[], centrals=[]; let offset=0;
  for (const item of items) {
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? ''); const name=Buffer.from(item.name); const packed=item.method===8?zlib.deflateRawSync(data):data;
    const local=Buffer.alloc(30), central=Buffer.alloc(46), flags=0x800, method=item.method??0, crc=crc32(data);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(flags,6); local.writeUInt16LE(method,8); local.writeUInt32LE(crc,14); local.writeUInt32LE(packed.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314,4); central.writeUInt16LE(20,6); central.writeUInt16LE(flags,8); central.writeUInt16LE(method,10); central.writeUInt32LE(crc,16); central.writeUInt32LE(packed.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(name.length,28); central.writeUInt32LE(offset,42);
    locals.push(local,name,packed); centrals.push(central,name); offset += local.length+name.length+packed.length;
  }
  const c=Buffer.concat(centrals), end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length,8); end.writeUInt16LE(items.length,10); end.writeUInt32LE(c.length,12); end.writeUInt32LE(offset,16); return Buffer.concat([...locals,c,end]);
}
function fixture(t, mutate = () => {}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'control-runtime-'))); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const classRoot=path.join(root,'classes'); fs.mkdirSync(path.join(classRoot,'dev/codeintelligence/desktop'),{recursive:true});
  const classes={
    'dev/codeintelligence/desktop/DesktopControlApplication.class':Buffer.from('dispatcher'),
    'dev/codeintelligence/desktop/NativeLeaseWorker.class':Buffer.from('lease'),
    'dev/codeintelligence/desktop/ManagedProcessWorker.class':Buffer.from('managed'),
    'dev/codeintelligence/desktop/ManagedProcessWorker$Guardian.class':Buffer.from('guardian'),
  };
  for(const [name,data] of Object.entries(classes)) fs.writeFileSync(path.join(classRoot,name),data);
  const deps=[
    {groupId:'tools.jackson.core',artifactId:'jackson-core',version:'3.1.7',fileName:'jackson-core-3.1.7.jar',sha256:'a'.repeat(64)},
    {groupId:'tools.jackson.core',artifactId:'jackson-databind',version:'3.1.7',fileName:'jackson-databind-3.1.7.jar',sha256:'b'.repeat(64)},
    {groupId:'com.fasterxml.jackson.core',artifactId:'jackson-annotations',version:'2.21.7',fileName:'jackson-annotations-2.21.7.jar',sha256:'c'.repeat(64)},
  ];
  const licenses=deps.map(d=>`META-INF/licenses/${d.groupId}/${d.artifactId}/${d.version}/LICENSE.txt`);
  const items=[{name:'META-INF/MANIFEST.MF',data:'Manifest-Version: 1.0\r\nMain-Class: dev.codeintelligence.desktop.DesktopControlApplication\r\n\r\n'},...Object.entries(classes).map(([name,data])=>({name,data})),{name:'tools/jackson/core/Dummy.class',data:'j'},...licenses.map(name=>({name,data:'license'}))];
  const state={classes,deps,licenses,items}; mutate(state);
  const jar=zip(state.items), jarFile=path.join(root,'control.jar'); fs.writeFileSync(jarFile,jar);
  const provenance={format:1,kind:'DESKTOP_CONTROL_RUNTIME',mainClass:'dev.codeintelligence.desktop.DesktopControlApplication',jarSha256:hash(jar),classes:Object.fromEntries(Object.entries(state.classes).map(([n,b])=>[n,hash(b)])),dependencies:state.deps,licenses:state.licenses};
  const provenanceFile=path.join(root,'provenance.json'); fs.writeFileSync(provenanceFile,JSON.stringify(provenance));
  return {root,classRoot,jarFile,provenanceFile,provenance};
}

test('valid minimum control runtime verifies static classes dependencies and licenses', async t => {
  const f=fixture(t); const result=await verifyControlRuntime(f); assert.equal(result.classesCount,4); assert.equal(result.dependencies.length,3); assert.equal(result.licenses.length,3);
});
test('compiled and jar class bytes must match', async t => {
  const f=fixture(t,s=>{s.items=s.items.map(i=>i.name==='dev/codeintelligence/desktop/ManagedProcessWorker.class'?{...i,data:'changed'}:i);}); await assert.rejects(verifyControlRuntime(f));
});
test('jar hash and licenses are mandatory', async t => {
  const a=fixture(t); a.provenance.jarSha256='0'.repeat(64); fs.writeFileSync(a.provenanceFile,JSON.stringify(a.provenance)); await assert.rejects(verifyControlRuntime(a));
  const b=fixture(t,s=>{s.licenses.pop();}); await assert.rejects(verifyControlRuntime(b));
});
test('extra Spring classes are rejected', async t => { const f=fixture(t,s=>s.items.push({name:'org/springframework/Foo.class',data:'x'})); await assert.rejects(verifyControlRuntime(f)); });
test('an extra same-family nested class absent from compiled output is rejected', async t => {
  const f=fixture(t,s=>s.items.push({name:'dev/codeintelligence/desktop/ManagedProcessWorker$Extra.class',data:'x'}));
  await assert.rejects(verifyControlRuntime(f), {code:'CONTROL_CLASS_SET'});
});
test('dependency set must be exactly the three reviewed Jackson artifacts', async t => { const f=fixture(t,s=>s.deps.pop()); await assert.rejects(verifyControlRuntime(f)); });
test('worker prefix extras are rejected', async t => { const f=fixture(t,s=>{const n='dev/codeintelligence/desktop/ManagedProcessWorkerExtra.class'; s.classes[n]=Buffer.from('x'); s.items.push({name:n,data:'x'});}); await assert.rejects(verifyControlRuntime(f)); });
test('manifest rejects external Class-Path', async t => { const f=fixture(t,s=>{s.items[0]={...s.items[0],data:'Manifest-Version: 1.0\r\nMain-Class: dev.codeintelligence.desktop.DesktopControlApplication\r\nClass-Path: x.jar\r\n\r\n'};}); await assert.rejects(verifyControlRuntime(f)); });
test('multi-release entries require an explicit Multi-Release manifest attribute', async t => {
  const f=fixture(t,s=>s.items.push({name:'META-INF/versions/21/tools/jackson/core/Versioned.class',data:'x'}));
  await assert.rejects(verifyControlRuntime(f), {code:'CONTROL_MANIFEST'});
});
test('provenance rejects undeclared top-level fields', async t => {
  const f=fixture(t); f.provenance.extra='x'; fs.writeFileSync(f.provenanceFile,JSON.stringify(f.provenance));
  await assert.rejects(verifyControlRuntime(f), {code:'CONTROL_PROVENANCE'});
});
test('symlink ancestor is rejected before reading the class bytes', async t => {
  const f=fixture(t), real=path.join(f.root,'real'), link=path.join(f.root,'linked'); fs.mkdirSync(real);
  fs.symlinkSync(f.classRoot,link); await assert.rejects(verifyControlRuntime({jarFile:f.jarFile,provenanceFile:f.provenanceFile,classRoot:link}));
});
test('corrupt zip is rejected', async t => { const f=fixture(t); const bytes=fs.readFileSync(f.jarFile); fs.writeFileSync(f.jarFile,bytes.subarray(0,bytes.length-1)); await assert.rejects(verifyControlRuntime(f)); });
test('symlink provenance is rejected', async t => { const f=fixture(t); const link=path.join(f.root,'link.json'); fs.symlinkSync(f.provenanceFile,link); await assert.rejects(verifyControlRuntime({jarFile:f.jarFile,provenanceFile:link,classRoot:f.classRoot})); });
