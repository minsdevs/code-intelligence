// Offline compilation only. Explicit, already available JDK 21 and dependency JARs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const directory=path.dirname(fileURLToPath(import.meta.url));
const repository=path.resolve(directory,'../..');
const javaHome=fs.realpathSync(process.argv[2]);
const dependencies=fs.realpathSync(process.argv[3]);
if(!/^JAVA_VERSION="21[."]/m.test(fs.readFileSync(path.join(javaHome,'release'),'utf8'))) throw new Error('JDK 21 is required');
const root=fs.realpathSync(fs.mkdtempSync('/tmp/ci-parser-flow-'));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const inputs={};const artifacts={};const jars={};
function walk(directory) {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(directory,e.name)):e.isFile()?[path.join(directory,e.name)]:[]);
}
function snapshot(source) {
  const relative=path.relative(repository,source);const bytes=fs.readFileSync(source);
  inputs[relative]=hash(bytes);const target=path.join(root,'sources',relative);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});return target;
}
for(const name of ['classes','reports','home','tmp','web','analyzer']) fs.mkdirSync(path.join(root,name),{mode:0o700});
fs.writeFileSync(path.join(root,'.ci-parser-flow-root'),'synthetic-only\n',{flag:'wx',mode:0o600});
const sources=walk(path.join(repository,'backend/src/main')).map(snapshot).filter(p=>p.endsWith('.java'));
snapshot(path.join(repository,'backend/src/test/resources/fixtures/ts-nullable-metadata.json'));
walk(path.join(repository,'analyzers/ts-analyzer/src')).forEach(snapshot);
for(const name of ['tsconfig.json','package.json','package-lock.json']) snapshot(path.join(repository,'analyzers/ts-analyzer',name));
const runner=snapshot(path.join(directory,'ParserFlowIntegration.java'));sources.push(runner);
for(const name of ['run.mjs','prepare.mjs']) {snapshot(path.join(directory,name));fs.copyFileSync(path.join(directory,name),path.join(root,name));}
for(const file of walk(dependencies).filter(p=>p.endsWith('.jar'))) jars[file]=hash(fs.readFileSync(file));
if(!Object.keys(jars).some(p=>path.basename(p)==='spring-boot-4.1.0.jar')) throw new Error('Expected current pinned Spring Boot dependencies');
const args=['--release','21','-encoding','UTF-8','-parameters','-proc:none','-cp',Object.keys(jars).join(path.delimiter),'-d',path.join(root,'classes'),...sources];
fs.writeFileSync(path.join(root,'compile.args'),args.map(x=>JSON.stringify(x)).join('\n'));
const compile=spawnSync(path.join(javaHome,'bin/javac'),['-J-XX:+DisableAttachMechanism','-J-Xmx512m','@'+path.join(root,'compile.args')],
  {cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',HOME:path.join(root,'home')},encoding:'utf8',timeout:60000});
fs.writeFileSync(path.join(root,'reports/compile-java.log'),(compile.stdout||'')+(compile.stderr||''));
if(compile.status!==0) throw new Error('Java compilation failed: '+root);
const require=createRequire(path.join(repository,'analyzers/ts-analyzer/package.json'));
const ts=require('typescript');const analyzer=path.join(root,'sources/analyzers/ts-analyzer');
// Module resolution reads the existing locked dependencies. It runs no install/build hooks.
fs.symlinkSync(path.join(repository,'analyzers/ts-analyzer/node_modules'),path.join(analyzer,'node_modules'));
const raw=ts.readConfigFile(path.join(analyzer,'tsconfig.json'),ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(raw.config,ts.sys,analyzer,{outDir:path.join(root,'analyzer'),sourceMap:false});
const program=ts.createProgram(parsed.fileNames,parsed.options);const emitted=program.emit();
const errors=[...ts.getPreEmitDiagnostics(program),...emitted.diagnostics];
fs.writeFileSync(path.join(root,'reports/compile-analyzer.log'),errors.length?ts.formatDiagnosticsWithColorAndContext(errors,
  {getCanonicalFileName:p=>p,getCurrentDirectory:()=>analyzer,getNewLine:()=> '\n'}):`PASS ${parsed.fileNames.length} TypeScript sources\n`);
if(errors.length) throw new Error('TypeScript compilation failed: '+root);
fs.symlinkSync(path.join(repository,'analyzers/ts-analyzer/node_modules'),path.join(root,'analyzer/node_modules'));
for(const name of ['classes','analyzer','sources']) for(const file of walk(path.join(root,name))) artifacts[path.relative(root,file)]=hash(fs.readFileSync(file));
for(const name of ['run.mjs','prepare.mjs']) artifacts[name]=hash(fs.readFileSync(path.join(root,name)));
fs.writeFileSync(path.join(root,'prepared.json'),JSON.stringify({format:1,createdAt:new Date().toISOString(),repository,javaHome,dependencies,inputs,artifacts,jars},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root,javaSources:sources.length,typescriptSources:parsed.fileNames.length,jars:Object.keys(jars).length}));
