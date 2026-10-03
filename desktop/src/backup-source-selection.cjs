'use strict';

// Database-derived object selection. Archive paths never become local filesystem paths.
const crypto = require('node:crypto');
const { createBackupExportPolicy, REVIEWED_SCHEMA } = require('./backup-export-policy.cjs');
const POLICY = createBackupExportPolicy(REVIEWED_SCHEMA);
const MAX_BYTES = 64 * 1024 * 1024;
function fail() { throw new Error('Backup source selection is invalid or incomplete.'); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function id(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail(); return value;
}
function oid(value) { if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) fail(); return value; }
function safePath(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 8192 || value.normalize('NFC') !== value
      || /[\\:\x00-\x1f\x7f]/.test(value) || /%(?:2e|2f|5c)/i.test(value)
      || value.split('/').length > 64 || value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail(); return value;
}
function list(value, max) { if (!Array.isArray(value) || value.length > max) fail(); }
const pathOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function normalizeSourceSelection(value) {
  exact(value, ['snapshots', 'commits', 'branches', 'headOid']);
  list(value.snapshots, 10000); list(value.commits, 50000); list(value.branches, 10000);
  const ids = new Set(); let count = 0;
  const snapshots = value.snapshots.map(s => {
    exact(s, ['snapshotId', 'commitOid', 'files']); id(s.snapshotId); oid(s.commitOid); list(s.files, 50000);
    if (ids.has(s.snapshotId)) fail(); ids.add(s.snapshotId); const paths = new Set();
    const files = s.files.map(f => {
      exact(f, ['path', 'gitOid', 'byteSize']); safePath(f.path); oid(f.gitOid);
      if (paths.has(f.path) || ++count > 50000 || !Number.isSafeInteger(f.byteSize) || f.byteSize < 0 || f.byteSize > 2097152) fail();
      paths.add(f.path); return { path: f.path, gitOid: f.gitOid, byteSize: f.byteSize };
    }).sort((a, b) => pathOrder(a.path, b.path));
    for (const name of paths) {
      const parts = name.split('/'); for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) fail();
    }
    return { snapshotId: s.snapshotId, commitOid: s.commitOid, files };
  }).sort((a, b) => BigInt(a.snapshotId) < BigInt(b.snapshotId) ? -1 : 1);
  const commits = value.commits.map(oid).sort(); if (new Set(commits).size !== commits.length) fail();
  const names = new Set(); const branches = value.branches.map(b => {
    exact(b, ['name', 'headOid']); safePath(b.name); oid(b.headOid); const lower = b.name.toLowerCase();
    if (names.has(lower) || /(?:\.\.|@\{|[ ~^:?*\[\]\\])/.test(b.name) || b.name.endsWith('.')
        || b.name.split('/').some(p => p.startsWith('.') || p.endsWith('.lock'))) fail(); names.add(lower);
    return { name: b.name, headOid: b.headOid };
  }).sort((a, b) => pathOrder(a.name, b.name));
  for (const name of names) {
    const parts = name.split('/'); for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/'))) fail();
  }
  const headOid = value.headOid;
  if (headOid !== null && (!oid(headOid) || !snapshots.some(s => s.commitOid === headOid)
      && !commits.includes(headOid) && !branches.some(b => b.headOid === headOid))) fail();
  const result = { snapshots, commits, branches, headOid };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) fail(); return result;
}
function sourceSelectionSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeSourceSelection(value))).digest('hex');
}
function createBackupSourceInventory() {
  const projects = new Map(), snapshots = new Map(), blobs = new Map(), manifests = new Map();
  let bytes = 0, sealed = false;
  function charge(row) { bytes += Buffer.byteLength(JSON.stringify(row)); if (bytes > MAX_BYTES) fail(); }
  function owner(projectId) { const value = projects.get(projectId); if (!value) fail(); return value; }
  function add(row) {
    if (sealed) fail();
    try {
      const expected = POLICY.projectRow(row?.table, row?.values);
      const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
      if (JSON.stringify(sorted(expected)) !== JSON.stringify(sorted(row))) fail();
    } catch { fail(); }
    const v = row.values;
    if (!['projects', 'snapshots', 'files', 'commits', 'branches', 'source_blobs', 'source_manifests', 'source_manifest_entries'].includes(row.table)) return;
    charge(row);
    switch (row.table) {
      case 'projects':
        if (projects.has(id(v.id))) fail();
        projects.set(v.id, { currentSnapshotId: v.current_snapshot_id, sourceType: v.source_type,
          snapshots: [], commits: [], branches: [], headOid: null }); break;
      case 'snapshots': {
        const p = owner(v.project_id); if (snapshots.has(id(v.id)) || ![0, 1].includes(v.source_contract_version)) fail();
        const s = { snapshotId: v.id, commitOid: oid(v.commit_sha), files: [], projectId: v.project_id, retained: v.source_contract_version === 1 };
        snapshots.set(v.id, s); p.snapshots.push(s);
        if (p.currentSnapshotId === s.snapshotId) p.headOid = s.commitOid; break;
      }
      case 'files': {
        const s = snapshots.get(v.snapshot_id); if (!s) fail(); safePath(v.path); oid(v.content_hash);
        if (s.files.some(file => file.path === v.path)) fail();
        if (BigInt(v.size) < 0n || BigInt(v.size) > 2097152n) fail();
        s.files.push({ path: v.path, gitOid: v.content_hash, byteSize: Number(v.size) }); break;
      }
      case 'commits': owner(v.project_id).commits.push(oid(v.sha)); break;
      case 'branches': owner(v.project_id).branches.push({ name: safePath(v.name), headOid: oid(v.head_sha) }); break;
      case 'source_blobs': {
        owner(v.project_id); const key = `${v.project_id}:${v.sha256}`; if (blobs.has(key)) fail();
        blobs.set(key, { projectId: v.project_id, sha256: v.sha256, byteSize: Number(v.byte_size), keyId: v.key_id }); break;
      }
      case 'source_manifests': {
        const s = snapshots.get(v.snapshot_id); if (!s?.retained || s.projectId !== v.project_id || !v.sealed_at || manifests.has(v.id)) fail();
        manifests.set(v.id, { snapshot: s, entries: new Map(), bytes: 0, expectedCount: v.file_count, expectedBytes: v.byte_size,
          policyVersion: v.policy_version, limitsSha256: v.limits_sha256, manifestSha256: v.approval_manifest_sha256 }); break;
      }
      case 'source_manifest_entries': {
        const m = manifests.get(v.manifest_id), b = blobs.get(`${v.project_id}:${v.blob_sha256}`);
        safePath(v.path); oid(v.git_oid);
        if (!m || m.snapshot.projectId !== v.project_id || !b || b.byteSize !== Number(v.byte_size) || m.entries.has(v.path)) fail();
        m.entries.set(v.path, { path: v.path, gitOid: v.git_oid, rawSha256: v.blob_sha256, byteSize: Number(v.byte_size) });
        m.bytes += Number(v.byte_size); break;
      }
    }
  }
  function finish() {
    if (sealed) fail(); sealed = true;
    const retained = new Map();
    for (const m of manifests.values()) {
      if (retained.has(m.snapshot.snapshotId) || m.entries.size !== m.expectedCount || String(m.bytes) !== m.expectedBytes) fail();
      retained.set(m.snapshot.snapshotId, m);
      for (const f of m.snapshot.files) {
        const entry = m.entries.get(f.path);
        if (!entry || entry.gitOid !== f.gitOid || entry.byteSize !== f.byteSize) fail();
      }
      // A retained manifest owns all captured files, including ones the analyzer skipped.
      // Include their exact Git objects so historical readers survive removal of the run clone.
      m.snapshot.files = [...m.entries.values()].map(({ path, gitOid, byteSize }) => ({ path, gitOid, byteSize }));
    }
    for (const s of snapshots.values()) if (s.retained && !retained.has(s.snapshotId)) fail();
    const git = [];
    for (const [projectId, p] of projects) {
      if (p.currentSnapshotId !== null && snapshots.get(p.currentSnapshotId)?.projectId !== projectId) fail();
      if (!p.snapshots.length && !p.commits.length && !p.branches.length) continue;
      const ordered = normalizeSourceSelection({ snapshots: p.snapshots.map(({ snapshotId, commitOid, files }) => ({ snapshotId, commitOid, files })),
        commits: p.commits, branches: p.branches, headOid: null });
      const selection = normalizeSourceSelection({ ...ordered,
        headOid: p.headOid || ordered.commits[0] || ordered.branches[0]?.headOid || ordered.snapshots[0]?.commitOid || null });
      git.push({ projectId, selection, selectionSha256: sourceSelectionSha256(selection) });
    }
    git.sort((a, b) => BigInt(a.projectId) < BigInt(b.projectId) ? -1 : 1);
    const vault = [...blobs.values()].sort((a, b) => a.projectId === b.projectId ? a.sha256.localeCompare(b.sha256)
      : BigInt(a.projectId) < BigInt(b.projectId) ? -1 : 1);
    const retainedSources = [...retained.values()].map(m => ({ projectId: m.snapshot.projectId,
      snapshotId: m.snapshot.snapshotId, commitOid: m.snapshot.commitOid, commitEpochSecond: null,
      policyVersion: m.policyVersion, limitsSha256: m.limitsSha256, manifestSha256: m.manifestSha256,
      fileCount: m.expectedCount, totalBytes: m.bytes,
      entries: [...m.entries.values()].sort((a, b) => pathOrder(a.path, b.path)) }))
      .sort((a, b) => BigInt(a.snapshotId) < BigInt(b.snapshotId) ? -1 : 1);
    return { git, vault, ...(retainedSources.length ? { retained: retainedSources } : {}) };
  }
  return Object.freeze({ add, finish });
}
module.exports = Object.freeze({ normalizeSourceSelection, sourceSelectionSha256, createBackupSourceInventory });
