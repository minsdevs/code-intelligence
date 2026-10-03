'use strict';

// Invoked only as a separate Node process with the build workspace's private env.
// Third-party archive code must never be loaded in the parent build process.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dependencyInventory } = require('./build-isolated.cjs');
function refuse() { throw new Error('BACKEND_JAR_INPUT_CHANGED'); }

async function verifyBuiltJar(workRoot, bootJar) {
  if (!path.isAbsolute(workRoot) || fs.realpathSync(workRoot) !== workRoot
      || path.dirname(bootJar) !== path.join(workRoot, 'backend', 'build', 'libs')
      || !fs.lstatSync(bootJar).isFile() || fs.lstatSync(bootJar).isSymbolicLink()) refuse();
  const unzipper = require(path.join(workRoot, 'desktop', 'node_modules', 'unzipper'));
  const archive = await unzipper.Open.file(bootJar);
  const expected = [
    { root: path.join(workRoot, 'frontend', 'dist'), prefix: 'BOOT-INF/classes/static/' },
    { root: path.join(workRoot, 'backend', 'src/main/resources/db/migration'), prefix: 'BOOT-INF/classes/db/migration/' },
  ];
  const counts = [];
  for (const group of expected) {
    const files = dependencyInventory(group.root).entries.filter(entry => entry.sha256);
    if (!files.length) refuse();
    for (const file of files) {
      const name = group.prefix + file.path.split(path.sep).join('/');
      const entries = archive.files.filter(entry => entry.path === name);
      if (entries.length !== 1 || entries[0].uncompressedSize !== file.size) refuse();
      const hash = crypto.createHash('sha256'), stream = entries[0].stream(); let bytes = 0;
      try {
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes > file.size) refuse();
          hash.update(chunk);
        }
      } finally { stream.destroy(); }
      if (bytes !== file.size || hash.digest('hex') !== file.sha256) refuse();
    }
    counts.push(files.length);
  }
  return { frontendArchiveReadbackVerified: true, frontendFiles: counts[0], migrationFiles: counts[1] };
}

if (require.main === module) {
  const [workRoot, bootJar] = process.argv.slice(2);
  verifyBuiltJar(workRoot, bootJar).then(result => {
    fs.writeFileSync(path.join(path.dirname(workRoot), 'output', 'jar-readback.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  }).catch(() => { console.error('BACKEND_JAR_READBACK_FAILED'); process.exitCode = 1; });
}

module.exports = { verifyBuiltJar };
