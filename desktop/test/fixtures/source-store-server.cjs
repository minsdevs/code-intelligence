'use strict';

// Disposable integration fixture only. The public key below is intentionally not secure storage.
// This exercises the production vault/broker without Electron, OS credentials or real userData.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSourceVault, openSourceVault } = require('../../src/source-vault.cjs');
const { createSourceBroker } = require('../../src/source-broker.cjs');

const wrappingKey = Buffer.alloc(32, 7);
const wrapper = {
  isAvailable: () => true,
  wrap(bytes) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce);
    return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  },
  unwrap(bytes) {
    if (bytes.length < 28) throw new Error('INVALID_SYNTHETIC_WRAPPER');
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  },
};

async function main() {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) throw new Error('INVALID_FIXTURE_CONFIG');
  const encoded = await fs.readFile(configPath);
  if (encoded.length > 4096) throw new Error('INVALID_FIXTURE_CONFIG');
  const config = JSON.parse(encoded.toString('utf8'));
  if (!config || Object.keys(config).sort().join(',') !== 'authToken,root,socketPath'
      || typeof config.root !== 'string' || await fs.realpath(config.root) !== config.root
      || config.socketPath !== path.join(config.root, 'broker.sock')
      || typeof config.authToken !== 'string' || !/^[0-9a-f]{64}$/.test(config.authToken)) {
    throw new Error('INVALID_FIXTURE_CONFIG');
  }
  const stat = await fs.lstat(config.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o700) throw new Error('INVALID_FIXTURE_ROOT');
  const options = {
    safetyRoot: path.join(config.root, 'safety'),
    sourceRoot: path.join(config.root, 'blobs'),
    installationId: 'retained-source-public-test-fixture',
    wrapper,
  };
  let initialized;
  try {
    await fs.lstat(path.join(options.safetyRoot, 'source-vault'));
    initialized = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    initialized = false;
  }
  const vault = initialized ? await openSourceVault(options) : await createSourceVault(options);
  let broker;
  try {
    broker = await createSourceBroker({ socketPath: config.socketPath, authToken: config.authToken, vault });
  } catch (error) {
    await vault.close();
    throw error;
  }
  let closing;
  const stop = () => {
    if (closing) return closing;
    closing = (async () => {
      // A failed broker drain does not authorize releasing the vault's writer ownership.
      await broker.close();
      await vault.close();
      wrappingKey.fill(0);
      process.stdin.destroy();
    })();
    closing.catch(() => {
      process.stderr.write('SOURCE_STORE_FIXTURE_STOP_FAILED\n');
      process.exitCode = 1;
      process.stdin.destroy();
    });
    return closing;
  };
  let command = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    command += chunk;
    if (command.length > 16 || (command.includes('\n') && command !== 'stop\n')) {
      process.stderr.write('SOURCE_STORE_FIXTURE_COMMAND_INVALID\n');
      process.exitCode = 1;
      void stop();
    } else if (command === 'stop\n') void stop();
  });
  process.stdin.once('end', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.stdout.write('READY\n');
}

main().catch(() => {
  process.stderr.write('SOURCE_STORE_FIXTURE_FAILED\n');
  process.exitCode = 1;
});
