'use strict';

// npm and the real downloader regression run only in a newly owned, credential-free copy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.argv.length !== 4 || process.argv[2] !== '--npm-cli') {
  throw new Error('Usage: node scripts/smoke-dependency-downloader.cjs --npm-cli /path/to/npm-cli.js');
}
const npmCli = fs.realpathSync(process.argv[3]);
const source = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-downloader-install-'));
fs.chmodSync(root, 0o700);
try {
  for (const relative of [
    'package.json', 'package-lock.json',
    'scripts/builder-downloader/package.json', 'scripts/builder-downloader/index.cjs',
    'test/dependency-downloader.test.cjs',
  ]) {
    const output = path.join(root, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(source, relative), output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, 0o600);
  }
  const home = path.join(root, 'home'), temporary = path.join(root, 'tmp');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(temporary, { mode: 0o700 });
  const userConfig = path.join(root, 'empty-user.npmrc'), globalConfig = path.join(root, 'empty-global.npmrc');
  fs.writeFileSync(userConfig, '', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(globalConfig, '', { mode: 0o600, flag: 'wx' });
  const env = {
    PATH: process.env.PATH || path.dirname(process.execPath),
    HOME: home, USERPROFILE: home, LOCALAPPDATA: home, XDG_CACHE_HOME: home,
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    npm_config_cache: path.join(root, 'npm-cache'),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  };
  const install = spawnSync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--install-links', '--no-audit', '--no-fund'], {
    cwd: root, env, stdio: 'inherit', timeout: 120000,
  });
  if (install.error || install.status !== 0) throw new Error('Isolated downloader dependency installation failed');
  const regression = spawnSync(process.execPath, ['--test', 'test/dependency-downloader.test.cjs'], {
    cwd: root, env, stdio: 'inherit', timeout: 90000,
  });
  if (regression.error || regression.status !== 0) throw new Error('Isolated real-builder downloader regression failed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
