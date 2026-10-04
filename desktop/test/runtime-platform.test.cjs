'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { runtimeRelativePath, runtimeFile, inheritedEnvironment, libraryEnvironment } = require('../src/runtime-platform.cjs');
const { windowsReadiness, requireWindowsReadiness } = require('../scripts/windows-readiness.cjs');
const beforePack = require('../scripts/desktop-build-gate.cjs');

test('Windows executable resolution handles spaces and Unicode without changing script and jar names', () => {
  const root = 'C:\\Users\\테스트 이름\\AppData\\Local\\Code Intelligence\\resources\\runtime';
  assert.equal(runtimeFile(root, ['jre','bin','java'], null, 'win32'), root+'\\jre\\bin\\java.exe');
  for (const name of ['postgres','initdb','pg_isready','psql','createdb','pg_dump','pg_restore']) {
    assert.equal(runtimeFile(root, ['postgres','bin',name], 'postgres/version/bin', 'win32'), root+'\\postgres\\version\\bin\\'+name+'.exe');
  }
  assert.equal(runtimeFile(root, ['redis','bin','redis-server'], null, 'win32'), root+'\\cache\\GarnetServer.exe');
  assert.equal(runtimeFile(root, ['backend','code-intelligence.jar'], null, 'win32'), root+'\\backend\\code-intelligence.jar');
  assert.equal(runtimeFile(root, ['ts-analyzer','dist','main.js'], null, 'win32'), root+'\\ts-analyzer\\dist\\main.js');
});

test('Mac executable and relocated PostgreSQL paths preserve current names', () => {
  assert.equal(runtimeFile('/Applications/Code Intelligence.app/runtime', ['jre','bin','java'], null, 'darwin'),
    '/Applications/Code Intelligence.app/runtime/jre/bin/java');
  assert.equal(runtimeFile('/runtime', ['postgres','bin','psql'], 'postgres/Cellar/pg/bin', 'darwin'), '/runtime/postgres/Cellar/pg/bin/psql');
});

for (const unsafe of ['../escape', '/absolute', 'C:relative', 'C:/absolute', '\\\\server\\share', 'dir\\file',
  'dir/../file', 'dir/./file', 'dir//file', 'dir/file:stream', 'bad\0name', 'bad\nname', 'dir/']) {
  test(`manifest rejects ambiguous path ${JSON.stringify(unsafe)} on both platforms`, () => {
    for(const platform of ['darwin','win32']) assert.throws(()=>runtimeRelativePath(unsafe,'file path',platform),/unsafe/);
  });
}
for (const unsafe of ['CON', 'dir/NUL.txt', 'dir/COM1.dll', 'dir/LPT².txt', 'dir/AUX', 'dir/file.', 'dir/file ', 'dir/a?b', 'dir/a*b']) {
  test(`Windows manifest rejects device or normalized alias ${unsafe}`, () => {
    assert.throws(()=>runtimeRelativePath(unsafe,'file path','win32'),/unsafe/);
  });
}

test('untrusted PostgreSQL layout and drive-relative runtime roots cannot escape the bundle', () => {
  assert.throws(()=>runtimeFile('C:\\runtime',['postgres','bin','psql'],'C:relative','win32'),/unsafe/);
  for (const unsafe of ['C:runtime', '\\\\server\\share\\runtime', '\\\\?\\C:\\runtime', '\\runtime', 'C:\\runtime\\..\\other'])
    assert.throws(()=>runtimeFile(unsafe,['jre','bin','java'],null,'win32'),/Invalid/);
  assert.throws(()=>runtimeFile('/runtime',['jre','bin','../java'],null,'darwin'),/Invalid/);
});

test('Windows child environment retains OS prerequisites but excludes keys and injection options', () => {
  const env={Path:'C:\\Windows\\System32',SYSTEMROOT:'C:\\Windows',TEMP:'C:\\Temp',USERPROFILE:'C:\\Users\\demo',
    NODE_OPTIONS:'injection',JAVA_TOOL_OPTIONS:'injection',JDK_JAVA_OPTIONS:'injection',CLASSPATH:'injection',OPENAI_API_KEY:'secret',PGPASSWORD:'secret'};
  assert.deepEqual(inheritedEnvironment(env,'win32'),{PATH:env.Path,SystemRoot:env.SYSTEMROOT,TEMP:env.TEMP,USERPROFILE:env.USERPROFILE});
  assert.deepEqual(libraryEnvironment('C:\\runtime',['postgres/bin','postgres/lib'],env,'win32'),
    {PATH:'C:\\runtime\\postgres\\bin;C:\\runtime\\postgres\\lib;C:\\Windows\\System32'});
  assert.deepEqual(libraryEnvironment('/runtime',['postgres/lib'],env,'darwin'),
    {DYLD_LIBRARY_PATH:'/runtime/postgres/lib',LD_LIBRARY_PATH:'/runtime/postgres/lib'});
});

test('Windows release gate remains independent of unsigned native product acceptance', async () => {
  assert.equal(windowsReadiness('win32','x64').status,'BLOCKED');
  assert.equal(windowsReadiness('darwin','arm64').nativeWindowsValidation,false);
  assert.throws(requireWindowsReadiness,/Windows packaging is blocked/);
  await assert.rejects(beforePack({electronPlatformName:'win32'}),/Windows packaging is blocked/);
  await beforePack({electronPlatformName:'darwin'});
});

test('pinned builder accepts Mac and Windows configuration without invoking a build', async () => {
  const config=require('../package.json').build;
  const { validateConfiguration }=require('app-builder-lib/out/util/config/config.js');
  await validateConfiguration(config,{isEnabled:false});
});
