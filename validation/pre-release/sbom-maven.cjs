'use strict';

// Declared-licence lookup for Maven artefacts. POM text comes from the packaged
// JAR (META-INF/maven/.../pom.xml) or, read-only, from Gradle's module cache and
// its parent chain. Only <licenses>, <parent> and the project coordinates are
// read; no Maven/Gradle code runs and nothing is fetched.
const fs = require('node:fs');
const path = require('node:path');

const COORD = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const MAX_POM = 2 * 1024 * 1024;
const MAX_PARENTS = 12;

function decodeXml(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function stripComments(text) { return text.replace(/<!--[\s\S]*?-->/g, ''); }
function element(block, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return match ? decodeXml(match[1]) : null;
}
// Remove nested sections whose child <groupId>/<version> would be mistaken for the
// project's own coordinates.
function topLevel(text) {
  return text.replace(/<(parent|dependencies|dependencyManagement|build|profiles|reporting|distributionManagement|pluginRepositories|repositories|modules|developers|contributors|licenses|scm|organization|issueManagement|ciManagement|mailingLists|properties)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, '');
}

function parsePom(text) {
  if (typeof text !== 'string' || text.length > MAX_POM || !/<project[\s>]/.test(text)) return null;
  const clean = stripComments(text);
  const licences = [];
  const block = /<licenses(?:\s[^>]*)?>([\s\S]*?)<\/licenses>/.exec(clean);
  if (block) {
    for (const match of block[1].matchAll(/<license(?:\s[^>]*)?>([\s\S]*?)<\/license>/g)) {
      const name = element(match[1], 'name'), url = element(match[1], 'url');
      if (name || url) licences.push({ name: name && name.slice(0, 200), url: url && url.slice(0, 300) });
    }
  }
  const parentBlock = /<parent(?:\s[^>]*)?>([\s\S]*?)<\/parent>/.exec(clean);
  const parent = parentBlock ? { groupId: element(parentBlock[1], 'groupId'), artifactId: element(parentBlock[1], 'artifactId'),
    version: element(parentBlock[1], 'version') } : null;
  const own = topLevel(clean);
  return { groupId: element(own, 'groupId') || parent?.groupId || null, artifactId: element(own, 'artifactId'),
    version: element(own, 'version') || parent?.version || null, licences,
    parent: parent && [parent.groupId, parent.artifactId, parent.version].every(value => COORD.test(value || '')) ? parent : null };
}

// Gradle module cache layout: <root>/<group>/<artifact>/<version>/<sha1>/<artifact>-<version>.pom
function cachedFile(cacheRoot, groupId, artifactId, version, extension) {
  if (![groupId, artifactId, version].every(value => COORD.test(value || '')) || !/^(?:pom|jar)$/.test(extension)) return [];
  const directory = path.join(cacheRoot, groupId, artifactId, version);
  let hashes;
  try { hashes = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const hash of hashes.filter(name => /^[a-f0-9]{30,40}$/.test(name)).sort()) {
    const file = path.join(directory, hash, `${artifactId}-${version}.${extension}`);
    try { const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink()) result.push(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
function readPom(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_POM) return null;
  return parsePom(fs.readFileSync(file, 'utf8'));
}

// First declaration wins: the artefact's own POM, then parents in order.
function declaredLicences({ embeddedPom, cacheRoot, groupId, artifactId, version }) {
  const chain = [];
  let pom = embeddedPom ? parsePom(embeddedPom) : null, source = pom ? 'EMBEDDED_POM' : null;
  if (!pom && cacheRoot) {
    const files = cachedFile(cacheRoot, groupId, artifactId, version, 'pom');
    if (files.length) { pom = readPom(files[0]); source = 'GRADLE_CACHE_POM'; }
  }
  let depth = 0;
  while (pom) {
    chain.push(`${pom.groupId}:${pom.artifactId}:${pom.version}`);
    if (pom.licences.length) return { licences: pom.licences, source: depth ? 'GRADLE_CACHE_PARENT_POM' : source, chain };
    if (!pom.parent || !cacheRoot || ++depth > MAX_PARENTS) break;
    const files = cachedFile(cacheRoot, pom.parent.groupId, pom.parent.artifactId, pom.parent.version, 'pom');
    pom = files.length ? readPom(files[0]) : null;
    if (!pom) chain.push('MISSING_PARENT');
  }
  return { licences: [], source: 'NONE', chain };
}

// Identify a packaged JAR that Gradle resolution did not report (for example a
// plugin-added JAR) by file name and exact SHA-256 against the module cache.
function findCachedByFile(cacheRoot, fileName, digest, hash) {
  if (!cacheRoot || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.jar$/.test(fileName) || !/^[a-f0-9]{64}$/.test(digest)) return null;
  const stem = fileName.slice(0, -4), splits = [];
  for (let i = 1; i < stem.length - 1; i++) if (stem[i] === '-' && /[0-9]/.test(stem[i + 1])) splits.push([stem.slice(0, i), stem.slice(i + 1)]);
  const matches = [];
  for (const group of fs.readdirSync(cacheRoot).filter(name => COORD.test(name))) {
    for (const [artifactId, version] of splits) {
      for (const file of cachedFile(cacheRoot, group, artifactId, version, 'jar')) {
        if (hash(fs.readFileSync(file)) === digest) matches.push({ groupId: group, artifactId, version });
      }
    }
  }
  return matches.length === 1 ? { ...matches[0], source: 'GRADLE_CACHE_FILE_SHA256' } : null;
}

module.exports = Object.freeze({ parsePom, cachedFile, declaredLicences, findCachedByFile });
