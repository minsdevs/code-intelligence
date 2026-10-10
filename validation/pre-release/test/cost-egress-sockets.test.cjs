'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inetSockets, parseInetSockets } = require('../cost-egress-packaged-probe.cjs');

const LSOF = ['p10', 'cCode\\x20Intelligence', 'f31', 'PTCP', 'n127.0.0.1:52000->127.0.0.1:5432', 'TST=ESTABLISHED',
  'f32', 'PTCP', 'n[::1]:8080', 'TST=LISTEN', 'p21', 'cParser', 'f12', 'PTCP', 'n[::1]:53010->[::127.0.0.1]:51208', 'TST=ESTABLISHED',
  'f13', 'PUDP', 'n*:5353', ''].join('\n');

test('lsof field output keeps the owning pid and command on every socket', () => {
  const sockets = parseInetSockets(LSOF);
  assert.deepEqual(sockets.map(s => [s.pid, s.command, s.fd, s.protocol, s.name, s.state]), [
    [10, 'Code\\x20Intelligence', '31', 'TCP', '127.0.0.1:52000->127.0.0.1:5432', 'ESTABLISHED'],
    [10, 'Code\\x20Intelligence', '32', 'TCP', '[::1]:8080', 'LISTEN'],
    [21, 'Parser', '12', 'TCP', '[::1]:53010->[::127.0.0.1]:51208', 'ESTABLISHED'],
    [21, 'Parser', '13', 'UDP', '*:5353', null],
  ]);
  assert.deepEqual(parseInetSockets(''), []);
});

test('a non-loopback peer is attributed to its process and scope, loopback peers are not reported', async () => {
  const reader = { read: async ownerPid => { assert.equal(ownerPid, 10); return [{ pid: 10, ppid: 1, rssKiB: 1 }, { pid: 21, ppid: 1, rssKiB: 1, scopeOwnerPid: 10 }]; } };
  const execute = async (file, args) => {
    assert.equal(file, '/usr/sbin/lsof'); assert.deepEqual(args, ['-nP', '-a', '-p', '10,21', '-i', '-F', 'pcfPnT']);
    return { stdout: LSOF, stderr: '' };
  };
  const value = await inetSockets(10, reader, { execute });
  assert.equal(value.processes, 2); assert.equal(value.sockets, 4);
  assert.deepEqual(value.remote, ['[::127.0.0.1]:51208']);
  assert.deepEqual(value.remoteDetails, [{ peer: '[::127.0.0.1]:51208', pid: 21, command: 'Parser', ppid: 1, scopeOwnerPid: 10,
    fd: '12', protocol: 'TCP', name: '[::1]:53010->[::127.0.0.1]:51208', state: 'ESTABLISHED' }]);
  const nothing = async () => { const error = new Error('lsof'); error.code = 1; throw error; };
  assert.deepEqual(await inetSockets(10, reader, { execute: nothing }), { processes: 2, sockets: 0, remote: [], remoteDetails: [] });
});
