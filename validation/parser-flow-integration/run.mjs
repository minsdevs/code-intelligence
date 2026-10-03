// Deliberately opt-in: never part of npm test, Gradle test, or desktop runtime.
// Creates only uniquely labelled, memory-backed containers from already cached images.
// Cleanup addresses owned container IDs, never OS PIDs or existing service names.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const root = fs.realpathSync(process.argv[2]);
const config = JSON.parse(fs.readFileSync(path.join(root,'prepared.json')));
if(config.format!==1 || !root.startsWith(fs.realpathSync('/tmp')+'/ci-parser-flow-')
    || fs.readFileSync(path.join(root,'.ci-parser-flow-root'),'utf8')!=='synthetic-only\n') throw new Error('Expected a fresh prepared synthetic workspace');
for(const [relative,expected] of Object.entries(config.artifacts)) {
  if(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,relative))).digest('hex')!==expected) throw new Error('Prepared artifact changed');
}
for(const [file,expected] of Object.entries(config.jars)) {
  if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==expected) throw new Error('Dependency changed');
}
fs.writeFileSync(path.join(root,'run.claim'),'single invocation\n',{flag:'wx',mode:0o600});
const nonce = crypto.randomUUID();
const labels = {'dev.codeintelligence.audit':nonce};
const report = {nonce,containers:[],network:null,cleanup:[],children:[],passed:false};
const abort = new AbortController();
const cleanupSignal = new AbortController().signal;
const deadline = setTimeout(()=>abort.abort(new Error('Integration deadline exceeded')),180000);
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>abort.abort(new Error('Run interrupted')));
let app;
let network;
const owned = [];
const password = crypto.randomBytes(24).toString('hex');

function docker(method,endpoint,body,expected=[200,201,204], signal=abort.signal) {
  return new Promise((resolve,reject)=>{
    const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
    const request=http.request({socketPath:'/var/run/docker.sock',path:endpoint,method,signal,timeout:15000,
      headers:bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}},response=>{
      let data=''; response.on('data',chunk=>{data+=chunk; if(data.length>1024*1024) request.destroy(new Error('Docker response too large'));});
      response.on('end',()=>{
        if(!expected.includes(response.statusCode)) return reject(new Error(`Docker ${method} ${endpoint.split('?')[0]} HTTP ${response.statusCode}`));
        resolve(data?JSON.parse(data):null);
      });
    });
    request.on('timeout',()=>request.destroy(new Error('Docker API timeout')));request.on('error',reject);request.end(bytes);
  });
}
function assertOwned(info,id) {
  if(info.Id!==id || (info.Config?.Labels||info.Labels)?.['dev.codeintelligence.audit']!==nonce)
    throw new Error('Refusing cleanup: resource identity/ownership mismatch');
}
async function createContainer(kind,image,port) {
  const name=`ci-parser-flow-${kind}-${nonce}`;
  const item={kind,name,id:null}; owned.push(item);
  const postgres=kind==='postgres';
  const body={Image:image,Labels:labels,ExposedPorts:{[port+'/tcp']:{}},
    Env:postgres?['POSTGRES_USER=ci_audit','POSTGRES_DB=ci_audit',`POSTGRES_PASSWORD=${password}`,'PGDATA=/var/lib/postgresql/data/pgdata']:[],
    ...(postgres?{}:{User:'999:999',Cmd:['redis-server','--save','','--appendonly','no','--requirepass',password]}),
    Healthcheck:{Test:postgres?['CMD','pg_isready','-U','ci_audit','-d','ci_audit']:['CMD','redis-cli','-a',password,'ping'],Interval:1000000000,Timeout:3000000000,Retries:30},
    HostConfig:{NetworkMode:network.id,ReadonlyRootfs:true,Memory:536870912,PidsLimit:128,NanoCpus:2000000000,
      SecurityOpt:['no-new-privileges'],CapDrop:['ALL'],CapAdd:postgres?['CHOWN','SETUID','SETGID','DAC_OVERRIDE','FOWNER']:[],
      Tmpfs:postgres?{'/var/lib/postgresql/data':'rw,nosuid,noexec,size=256m','/var/run/postgresql':'rw,nosuid,noexec,size=16m','/tmp':'rw,nosuid,noexec,size=32m'}:{'/data':'rw,nosuid,noexec,mode=1777,size=32m'},
      PortBindings:{[port+'/tcp']:[{HostIp:'127.0.0.1',HostPort:''}]}}};
  const created=await docker('POST','/containers/create?name='+encodeURIComponent(name),body);item.id=created.Id;
  if(!/^[a-f0-9]{64}$/.test(item.id)) throw new Error('Invalid owned container ID');
  await docker('POST',`/containers/${item.id}/start`);
  for(let count=0;count<50;count++) {
    const info=await docker('GET',`/containers/${item.id}/json`);assertOwned(info,item.id);
    if(info.State.Health?.Status==='healthy') {
      const bindings=info.NetworkSettings.Ports[port+'/tcp'];
      if(bindings?.length!==1 || bindings[0].HostIp!=='127.0.0.1') throw new Error('Expected loopback-only port binding: '+JSON.stringify(bindings));
      report.containers.push({kind,id:item.id,image,temporaryMemoryStorage:true,loopbackOnly:true});
      return Number(bindings[0].HostPort);
    }
    if(!info.State.Running) throw new Error('Owned container failed to start: '+kind);
    await delay(200,undefined,{signal:abort.signal});
  }
  throw new Error('Owned container readiness timed out: '+kind);
}
async function child(command,args) {
  await new Promise((resolve,reject)=>{
    const log=fs.openSync(path.join(root,'reports/java-integration.log'),'wx');
    const proc=spawn(command,args,{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:path.join(root,'home'),LANG:'en_US.UTF-8'},stdio:['ignore',log,log]});
    fs.closeSync(log);
    let closed=false,killTimer;
    // These methods address the direct ChildProcess object owned by this invocation.
    // No PID value is read, persisted, probed, or used as a signal target.
    const stop=()=>{
      if(closed || proc.exitCode!==null || proc.signalCode!==null) return;
      proc.kill('SIGTERM');
      killTimer=setTimeout(()=>{if(!closed && proc.exitCode===null && proc.signalCode===null) proc.kill('SIGKILL');},3000);
    };
    abort.signal.addEventListener('abort',stop,{once:true});
    proc.once('error',reject);
    proc.once('close',(code,signal)=>{
      closed=true;clearTimeout(killTimer);abort.signal.removeEventListener('abort',stop);
      report.children.push({name:'java-integration',exitCode:code,signal,closed:true});
      if(code===0 && !abort.signal.aborted) resolve();else reject(new Error('Java integration failed; see retained log'));
    });
    if(abort.signal.aborted) stop();
  });
}

try {
  // Pin cached image content, with no pull/build API or registry request.
  const images=[];
  for(const tag of ['pgvector/pgvector:pg16','redis:7-alpine']) {
    const info=await docker('GET','/images/'+encodeURIComponent(tag)+'/json');
    if(!/^sha256:[a-f0-9]{64}$/.test(info.Id)) throw new Error('Invalid cached image ID');
    images.push(info.Id);
  }
  network={id:null,name:`ci-parser-flow-${nonce}`};
  // Docker internal networks can suppress published host ports. A dedicated bridge with
  // explicit loopback-only publication is used here. This is not an egress sandbox;
  // the runner makes no external requests, pulls, uploads or registry/build calls.
  const created=await docker('POST','/networks/create',{Name:network.name,Labels:labels,CheckDuplicate:true});
  network.id=created.Id; report.network={id:network.id,dedicatedBridge:true,egressIsolation:false};
  const postgresPort=await createContainer('postgres',images[0],5432);
  const redisPort=await createContainer('redis',images[1],6379);
  const require=createRequire(path.join(root,'analyzer/app.module.js'));
  require('reflect-metadata');
  const {NestFactory}=require('@nestjs/core');const {json}=require('express');
  app=await NestFactory.create(require('./app.module.js').AppModule,{logger:false,abortOnError:false});
  app.use(json({limit:'10mb'}));await app.listen(0,'127.0.0.1');
  const analyzerUrl=await app.getUrl();
  fs.writeFileSync(path.join(root,'connection.json'),JSON.stringify({postgresPort,redisPort,password,analyzerUrl}),{flag:'wx',mode:0o600});
  await child(path.join(config.javaHome,'bin/java'),['-XX:+DisableAttachMechanism','-Xmx512m',
    '-Djava.io.tmpdir='+path.join(root,'tmp'),'-Duser.home='+path.join(root,'home'),
    '-cp',path.join(root,'classes')+':'+path.join(config.dependencies,'*'),'ParserFlowIntegration',root]);
  report.passed=true;
} catch(error) {
  report.error=error.message;process.exitCode=1;
} finally {
  clearTimeout(deadline);
  try { if(app) { await app.close();report.cleanup.push({resource:'Nest application',closed:true}); } }
  catch(error) { report.cleanup.push({resource:'Nest application',closed:false,error:error.message});process.exitCode=1; }
  // Recovery for a lost create response is restricted to the unique name generated above,
  // and still requires this invocation's random ownership label before any mutation.
  for(const item of owned.reverse()) {
    try {
      const info=await docker('GET',`/containers/${item.id||item.name}/json`,undefined,[200,404],cleanupSignal);
      if(info?.message && !info.Id) continue;
      item.id??=info.Id;assertOwned(info,item.id);
      if(info.State.Running) await docker('POST',`/containers/${item.id}/stop?t=5`,undefined,[204,304],cleanupSignal);
      const stopped=await docker('GET',`/containers/${item.id}/json`,undefined,[200],cleanupSignal);assertOwned(stopped,item.id);
      if(stopped.State.Running) throw new Error('Container did not stop');
      await docker('DELETE',`/containers/${item.id}?v=1`,undefined,[204],cleanupSignal);
      report.cleanup.push({resource:item.kind,id:item.id,stopped:true,removed:true});
    } catch(error) {report.cleanup.push({resource:item.kind,id:item.id,removed:false,error:error.message});process.exitCode=1;}
  }
  if(network) {
    try {
      const info=await docker('GET',`/networks/${network.id||network.name}`,undefined,[200],cleanupSignal);
      network.id??=info.Id;assertOwned(info,network.id);
      await docker('DELETE',`/networks/${network.id}`,undefined,[204],cleanupSignal);
      report.cleanup.push({resource:'dedicated network',id:network.id,removed:true});
    } catch(error) {report.cleanup.push({resource:'dedicated network',removed:false,error:error.message});process.exitCode=1;}
  }
  // The only persisted connection values are disposable synthetic secrets; remove after use.
  if(fs.existsSync(path.join(root,'connection.json'))) fs.unlinkSync(path.join(root,'connection.json'));
  report.passed=report.passed && !process.exitCode;
  fs.writeFileSync(path.join(root,'reports/lifecycle.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report,null,2));
}
