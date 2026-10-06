'use strict';

// Deterministic, offline workload fixtures for the G-PERF size classes. Every byte is
// produced here from fixed templates and a seeded generator: no network, no copied
// third-party source and no build or install scripts. Generated trees are evidence
// inputs only; they are never committed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GENERATOR = 'workload-fixture-v1';
const MiB = 1024 * 1024;
const SIZE_CLASSES = Object.freeze({
  small: Object.freeze({ files: 1000, bytes: 5 * MiB }),
  medium: Object.freeze({ files: 10000, bytes: 50 * MiB }),
  large: Object.freeze({ files: 50000, bytes: 200 * MiB }),
});
// Shares of the non-fixed files and bytes. The same mix is used for every class so
// the classes differ only in size. TypeScript/JavaScript is half of the bytes.
const MIX = Object.freeze({
  count: Object.freeze({ java: 0.45, nest: 0.18, react: 0.17 }),
  bytes: Object.freeze({ java: 0.5, ts: 0.18, tsx: 0.17, js: 0.15 }),
});
const MAX_FILE_BYTES = 512 * 1024;
const WORDS = Object.freeze(['catalog', 'order', 'ledger', 'shipment', 'invoice', 'region', 'quota', 'batch',
  'review', 'archive', 'schedule', 'inventory', 'customer', 'supplier', 'payment', 'refund', 'report', 'metric',
  'channel', 'segment', 'cohort', 'profile', 'billing', 'warehouse', 'route', 'parcel', 'carrier', 'station',
  'window', 'budget', 'forecast', 'audit', 'policy', 'contract', 'renewal', 'notice', 'summary', 'detail']);

function rngFor(seed) {
  // mulberry32 over a 32-bit seed derived from the textual seed.
  let state = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const peer = (index, count, step) => (count < 2 ? index : ((index * step + 3) % count === index
  ? (index + 1) % count : (index * step + 3) % count));

function commentFill(bytes, rng, prefix = '//') {
  // Exactly `bytes` bytes of ASCII comment lines.
  assert(Number.isSafeInteger(bytes) && bytes >= 0);
  let out = '';
  let remaining = bytes;
  while (remaining > 0) {
    if (remaining < prefix.length + 2) { out += '\n'.repeat(remaining); break; }
    const length = Math.min(remaining, 72 + Math.floor(rng() * 8));
    const rest = remaining - length;
    // Never leave a tail that cannot be a comment line or a blank line.
    const lineLength = rest > 0 && rest < prefix.length + 2 ? length - (prefix.length + 2 - rest) : length;
    let text = '';
    while (text.length < lineLength - prefix.length - 2) text += (text ? ' ' : '') + pick(rng, WORDS);
    text = text.slice(0, lineLength - prefix.length - 2).replace(/ $/, 'x');
    out += prefix + ' ' + text + '\n';
    remaining -= lineLength;
  }
  return out;
}

// Helper bodies are sized like ordinary application methods (about 450-600 bytes each,
// with a loop, two branches and a call), not one-line stubs, so the symbol density per
// byte stays in the range of real Spring/TypeScript code.
function constants(rng) {
  return { a: 2 + Math.floor(rng() * 17), b: Math.floor(rng() * 97), c: 100 + Math.floor(rng() * 900),
    n: 3 + Math.floor(rng() * 9), w: [pick(rng, WORDS), pick(rng, WORDS), pick(rng, WORDS)] };
}
function javaHelper(module, k, rng) {
  const { a, b, c, n, w } = constants(rng);
  const call = k === 0 ? `scaled - ${c}` : `normalize${k - 1}(scaled - ${c})`;
  return `\n    /**\n     * Normalizes the ${w[0]} value for step ${k} of module ${module}.\n`
    + `     * The ${w[1]} adjustment keeps the ${w[2]} range bounded.\n     */\n`
    + `    int normalize${k}(int value) {\n        int scaled = value * ${a} + ${b};\n        int total = 0;\n`
    + `        for (int index = 0; index < ${n}; index++) {\n            total += (scaled + index) % ${c};\n        }\n`
    + `        String label = "${w[0]}-" + total;\n        if (label.isEmpty()) {\n            throw new IllegalStateException(label);\n        }\n`
    + `        if (scaled > ${c}) {\n            return ${call} + total;\n        }\n        return scaled - total;\n    }\n`;
}
function tsBody(rng, call, indent) {
  const { a, b, c, n, w } = constants(rng);
  const p = indent;
  return { w, text: `${p}  const scaled = value * ${a} + ${b}\n${p}  let total = 0\n`
    + `${p}  for (let index = 0; index < ${n}; index += 1) {\n${p}    total += (scaled + index) % ${c}\n${p}  }\n`
    + `${p}  const label = '${w[0]}-' + total\n${p}  if (label.length === 0) {\n${p}    throw new Error(label)\n${p}  }\n`
    + `${p}  if (scaled > ${c}) {\n${p}    return ${call(c)} + total\n${p}  }\n${p}  return scaled - total\n` };
}
function tsHelper(name, k, rng, typed) {
  const body = tsBody(rng, c => (k === 0 ? `scaled - ${c}` : `${name}${k - 1}(scaled - ${c})`), '');
  const sig = typed ? `(value: number): number` : '(value)';
  return `\n/**\n * Adjusts the ${body.w[0]} value for step ${k}.\n * Keeps the ${body.w[1]} range bounded.\n */\n`
    + `export function ${name}${k}${sig} {\n${body.text}}\n`;
}
function tsMethod(k, rng) {
  const body = tsBody(rng, c => (k === 0 ? `scaled - ${c}` : `this.adjust${k - 1}(scaled - ${c})`), '  ');
  return `\n  /**\n   * Adjusts the ${body.w[0]} value for step ${k}.\n   * Keeps the ${body.w[1]} range bounded.\n   */\n`
    + `  adjust${k}(value: number): number {\n${body.text}  }\n`;
}

// Each builder returns { head, helper(k), tail, comment } so content can grow to an exact size
// with real declarations and call edges, then a residual comment.
function javaFile(kind, i, ctx, rng) {
  const pkg = `com.example.workload.m${i}`, j = peer(i, ctx.javaModules, 7);
  const word = pick(rng, WORDS);
  const builders = {
    entity: () => ({ head: `package ${pkg};\n\nimport jakarta.persistence.Entity;\nimport jakarta.persistence.Id;\n\n`
      + `@Entity\npublic class Item${i} {\n    @Id\n    private Long id;\n    private String name;\n    private int ${word}Count;\n\n`
      + `    public Long getId() {\n        return id;\n    }\n\n    public String getName() {\n        return name;\n    }\n`,
    tail: '}\n' }),
    repository: () => ({ head: `package ${pkg};\n\nimport java.util.List;\nimport org.springframework.data.jpa.repository.JpaRepository;\n\n`
      + `public interface Item${i}Repository extends JpaRepository<Item${i}, Long> {\n    List<Item${i}> findByName(String name);\n`,
    tail: '}\n', weight: 0.3, helper: k => `\n    /** Counts ${pick(rng, WORDS)} rows for filter ${k}. */\n    long countByWeight${k}(int weight);\n` }),
    service: () => ({ head: `package ${pkg};\n\nimport com.example.workload.m${j}.Item${j}Service;\nimport java.util.List;\n`
      + `import org.springframework.stereotype.Service;\n\n@Service\npublic class Item${i}Service {\n`
      + `    static final int REVISION = 1;\n    private final Item${i}Repository repository;\n    private final Item${j}Service peer;\n\n`
      + `    public Item${i}Service(Item${i}Repository repository, Item${j}Service peer) {\n        this.repository = repository;\n        this.peer = peer;\n    }\n\n`
      + `    public List<Item${i}> byName(String name) {\n        return repository.findByName(name);\n    }\n\n`
      + `    public Item${i}Dto describe(long id) {\n        int weight = peer.weight(id) + REVISION;\n        return new Item${i}Dto(id, "item-${i}", weight);\n    }\n\n`
      + `    public int weight(long id) {\n        return (int) (id % ${11 + (i % 89)});\n    }\n`,
    tail: '}\n' }),
    controller: () => ({ head: `package ${pkg};\n\nimport java.util.List;\nimport org.springframework.web.bind.annotation.GetMapping;\n`
      + `import org.springframework.web.bind.annotation.PathVariable;\nimport org.springframework.web.bind.annotation.PostMapping;\n`
      + `import org.springframework.web.bind.annotation.RequestBody;\nimport org.springframework.web.bind.annotation.RequestMapping;\n`
      + `import org.springframework.web.bind.annotation.RequestParam;\nimport org.springframework.web.bind.annotation.RestController;\n\n`
      + `@RestController\n@RequestMapping("/api/items${i}")\npublic class Item${i}Controller {\n    private final Item${i}Service service;\n\n`
      + `    public Item${i}Controller(Item${i}Service service) {\n        this.service = service;\n    }\n\n`
      + `    @GetMapping("/{id}")\n    public Item${i}Dto get(@PathVariable long id) {\n        return service.describe(id);\n    }\n\n`
      + `    @GetMapping("/search")\n    public List<Item${i}> search(@RequestParam String name) {\n        return service.byName(name);\n    }\n\n`
      + `    @PostMapping\n    public Item${i}Dto create(@RequestBody Item${i}Dto body) {\n        return service.describe(body.id());\n    }\n`,
    tail: '}\n' }),
    dto: () => ({ head: `package ${pkg};\n\npublic record Item${i}Dto(long id, String label, int weight) {\n`, tail: '}\n',
      weight: 0.4, helper: k => `\n    /** Scales the ${pick(rng, WORDS)} weight by ${k + 2}. */\n    public int scaled${k}() {\n        return weight * ${k + 2} + ${i % 97};\n    }\n` }),
  };
  const spec = builders[kind]();
  const fileName = { entity: `Item${i}`, repository: `Item${i}Repository`, service: `Item${i}Service`,
    controller: `Item${i}Controller`, dto: `Item${i}Dto` }[kind];
  return { path: `src/main/java/com/example/workload/m${i}/${fileName}.java`, ...spec,
    helper: spec.helper ?? (k => javaHelper(i, k, rng)), comment: '//' };
}

function nestFile(kind, i, ctx, rng) {
  const j = peer(i, ctx.nestModules, 5), dir = `server/src/n${i}`;
  if (kind === 'service') return { path: `${dir}/n${i}.service.ts`,
    head: `import { Injectable } from '@nestjs/common'\nimport { N${j}Service } from '../n${j}/n${j}.service'\n\n`
      + `@Injectable()\nexport class N${i}Service {\n  static readonly revision = 1\n\n  constructor(private readonly peer: N${j}Service) {}\n\n`
      + `  find(id: number): { id: number; weight: number } {\n    return { id, weight: this.peer.weight(id) + N${i}Service.revision }\n  }\n\n`
      + `  weight(id: number): number {\n    return id % ${11 + (i % 89)}\n  }\n`,
    tail: '}\n', helper: k => tsMethod(k, rng), comment: '//' };
  if (kind === 'controller') return { path: `${dir}/n${i}.controller.ts`,
    head: `import { Body, Controller, Get, Param, Post } from '@nestjs/common'\nimport { N${i}Service } from './n${i}.service'\n\n`
      + `export interface CreateN${i} {\n  id: number\n  label: string\n}\n\n`
      + `@Controller('n${i}')\nexport class N${i}Controller {\n  constructor(private readonly service: N${i}Service) {}\n\n`
      + `  @Get(':id')\n  find(@Param('id') id: string) {\n    return this.service.find(Number(id))\n  }\n\n`
      + `  @Post()\n  create(@Body() body: CreateN${i}) {\n    return this.service.find(body.id)\n  }\n`,
    tail: '}\n', helper: k => tsMethod(k, rng), comment: '//' };
  return { path: `${dir}/n${i}.module.ts`,
    head: `import { Module } from '@nestjs/common'\nimport { N${i}Controller } from './n${i}.controller'\nimport { N${i}Service } from './n${i}.service'\n`
      + `import { N${j}Module } from '../n${j}/n${j}.module'\n\n`
      + `@Module({\n  imports: [N${j}Module],\n  controllers: [N${i}Controller],\n  providers: [N${i}Service],\n  exports: [N${i}Service],\n})\n`
      + `export class N${i}Module {}\n`,
    tail: '', helper: k => tsHelper(`n${i}Setting`, k, rng, true), comment: '//' };
}

function reactFile(kind, i, ctx, rng) {
  const dir = `web/src/pages/p${i}`, javaTarget = i % Math.max(1, ctx.javaModules), util = i % Math.max(1, ctx.jsFiles);
  if (kind === 'page') return { path: `${dir}/Page${i}.tsx`,
    head: `import { useEffect, useState } from 'react'\nimport { Panel${i} } from './Panel${i}'\nimport { u${util}Value } from '../../lib/u${util}.js'\n\n`
      + `export default function Page${i}() {\n  const [weight, setWeight] = useState(0)\n  useEffect(() => {\n`
      + `    fetch('/api/items${javaTarget}/' + u${util}Value(${i}))\n      .then((response) => response.json())\n`
      + `      .then((body: { weight: number }) => setWeight(body.weight))\n  }, [])\n`
      + `  return <Panel${i} title="Page ${i}" weight={weight} />\n}\n`,
    tail: '', helper: k => tsHelper(`page${i}Step`, k, rng, true), comment: '//' };
  return { path: `${dir}/Panel${i}.tsx`,
    head: `export const PANEL${i}_REVISION = 1\n\nexport interface Panel${i}Props {\n  title: string\n  weight: number\n}\n\n`
      + `export function Panel${i}({ title, weight }: Panel${i}Props) {\n  return (\n    <section aria-label={title}>\n`
      + `      <h2>{title}</h2>\n      <p>{weight + PANEL${i}_REVISION}</p>\n    </section>\n  )\n}\n`,
    tail: '', helper: k => tsHelper(`panel${i}Step`, k, rng, true), comment: '//' };
}

function jsFile(i, ctx, rng) {
  const j = peer(i, ctx.jsFiles, 3);
  return { path: `web/src/lib/u${i}.js`,
    head: (j === i ? '' : `import { u${j}Value } from './u${j}.js'\n\n`) + `export const U${i}_REVISION = 1\n\n`
      + `export function u${i}Value(input) {\n  const base = Number(input) + U${i}_REVISION\n`
      + `  return ${j === i ? 'base' : `u${j}Value(base) % ${101 + (i % 53)}`}\n}\n`,
    tail: '', helper: k => tsHelper(`u${i}Step`, k, rng, false), comment: '//' };
}

function fixedFiles(ctx) {
  const pages = Array.from({ length: ctx.reactModules }, (_, i) => i);
  const nest = Array.from({ length: ctx.nestModules }, (_, i) => i);
  const files = {
    'pom.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n'
      + '  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>workload</artifactId>\n'
      + '  <version>1.0.0</version>\n  <parent>\n    <groupId>org.springframework.boot</groupId>\n'
      + '    <artifactId>spring-boot-starter-parent</artifactId>\n    <version>3.3.0</version>\n  </parent>\n'
      + '  <dependencies>\n    <dependency>\n      <groupId>org.springframework.boot</groupId>\n'
      + '      <artifactId>spring-boot-starter-web</artifactId>\n    </dependency>\n    <dependency>\n'
      + '      <groupId>org.springframework.boot</groupId>\n      <artifactId>spring-boot-starter-data-jpa</artifactId>\n'
      + '    </dependency>\n  </dependencies>\n</project>\n',
    'src/main/java/com/example/workload/WorkloadApplication.java': 'package com.example.workload;\n\n'
      + 'import org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n'
      + '@SpringBootApplication\npublic class WorkloadApplication {\n    public static void main(String[] args) {\n'
      + '        SpringApplication.run(WorkloadApplication.class, args);\n    }\n}\n',
    'server/package.json': JSON.stringify({ name: 'workload-server', version: '1.0.0', private: true,
      dependencies: { '@nestjs/common': '^10.0.0', '@nestjs/core': '^10.0.0' } }, null, 2) + '\n',
    'server/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2021', module: 'commonjs',
      experimentalDecorators: true, emitDecoratorMetadata: true, strict: true } }, null, 2) + '\n',
    'server/src/app.module.ts': "import { Module } from '@nestjs/common'\n"
      + nest.map(i => `import { N${i}Module } from './n${i}/n${i}.module'\n`).join('')
      + `\n@Module({\n  imports: [${nest.map(i => `N${i}Module`).join(', ')}],\n})\nexport class AppModule {}\n`,
    'web/package.json': JSON.stringify({ name: 'workload-web', version: '1.0.0', private: true,
      dependencies: { react: '^18.0.0', 'react-router-dom': '^6.0.0' } }, null, 2) + '\n',
    'web/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2021', module: 'ESNext', jsx: 'react-jsx',
      strict: true, allowJs: true } }, null, 2) + '\n',
    'web/src/router.tsx': "import { Route, Routes } from 'react-router-dom'\n"
      + pages.map(i => `import Page${i} from './pages/p${i}/Page${i}'\n`).join('')
      + '\nexport function AppRoutes() {\n  return (\n    <Routes>\n'
      + pages.map(i => `      <Route path="/p${i}" element={<Page${i} />} />\n`).join('') + '    </Routes>\n  )\n}\n',
  };
  return Object.entries(files).map(([file, content]) => ({ path: file, content, kind: 'fixed' }));
}

function planCounts(files) {
  const fixed = 8, remaining = files - fixed;
  assert(Number.isSafeInteger(files) && remaining >= 20, 'WORKLOAD_FILE_COUNT_INVALID');
  const javaModules = Math.floor(remaining * MIX.count.java / 5);
  const nestModules = Math.floor(remaining * MIX.count.nest / 3);
  const reactModules = Math.floor(remaining * MIX.count.react / 2);
  const jsFiles = remaining - javaModules * 5 - nestModules * 3 - reactModules * 2;
  assert(javaModules > 0 && nestModules > 0 && reactModules > 0 && jsFiles > 0, 'WORKLOAD_FILE_COUNT_INVALID');
  return { javaModules, nestModules, reactModules, jsFiles };
}

function buildContent(spec, target) {
  let content = spec.head;
  const close = spec.tail;
  if (spec.helper) {
    for (let k = 0; ; k++) {
      const next = spec.helper(k);
      if (Buffer.byteLength(content + next + close) > target) break;
      content += next;
    }
  }
  content += close;
  const size = Buffer.byteLength(content);
  return size >= target ? content : content + commentFill(target - size, spec.rng, spec.comment);
}

// Returns the ordered file list with exact contents; total file count and bytes are exact.
function planWorkload({ files, bytes, seed }) {
  assert(Number.isSafeInteger(bytes) && bytes > 0, 'WORKLOAD_BYTE_BUDGET_INVALID');
  assert(typeof seed === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(seed), 'WORKLOAD_SEED_INVALID');
  const ctx = planCounts(files);
  const rng = rngFor(GENERATOR + ':' + seed + ':' + files + ':' + bytes);
  const fixed = fixedFiles(ctx);
  const fixedBytes = fixed.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  const groups = { java: [], ts: [], tsx: [], js: [] };
  for (let i = 0; i < ctx.javaModules; i++) {
    for (const kind of ['entity', 'repository', 'service', 'controller', 'dto']) groups.java.push(javaFile(kind, i, ctx, rng));
  }
  for (let i = 0; i < ctx.nestModules; i++) for (const kind of ['service', 'controller', 'module']) groups.ts.push(nestFile(kind, i, ctx, rng));
  for (let i = 0; i < ctx.reactModules; i++) for (const kind of ['page', 'panel']) groups.tsx.push(reactFile(kind, i, ctx, rng));
  for (let i = 0; i < ctx.jsFiles; i++) groups.js.push(jsFile(i, ctx, rng));
  const available = bytes - fixedBytes;
  assert(available > 0, 'WORKLOAD_BYTE_BUDGET_TOO_SMALL');
  const out = [...fixed];
  let assigned = 0, debt = 0;
  const order = ['java', 'ts', 'tsx', 'js'];
  for (const [groupIndex, name] of order.entries()) {
    const group = groups[name];
    const groupBudget = groupIndex === order.length - 1 ? available - assigned : Math.floor(available * MIX.bytes[name]);
    assigned += groupBudget;
    const weights = group.map(spec => (spec.weight ?? 1) * (0.5 + rng()));
    const total = weights.reduce((a, b) => a + b, 0);
    let given = 0;
    group.forEach((spec, index) => {
      const share = index === group.length - 1 ? groupBudget - given : Math.floor(groupBudget * weights[index] / total);
      given += share;
      const target = Math.min(MAX_FILE_BYTES, share - debt);
      const content = buildContent({ ...spec, rng }, Math.max(0, target));
      const size = Buffer.byteLength(content);
      debt = size - (share - debt);
      out.push({ path: spec.path, content, kind: name });
    });
  }
  // A negative debt is a shortfall only when a file reached the per-file cap; place it
  // as comment lines in the largest-remaining-room files without exceeding the cap.
  assert(debt <= 0, 'WORKLOAD_BYTE_BUDGET_TOO_SMALL');
  let shortfall = debt < 0 ? -debt : 0;
  if (shortfall > 0) {
    for (let index = out.length - 1; index >= 0 && shortfall > 0; index--) {
      if (out[index].kind === 'fixed') continue;
      const room = MAX_FILE_BYTES - Buffer.byteLength(out[index].content);
      const add = Math.min(room, shortfall);
      if (add > 0) { out[index].content += commentFill(add, rng); shortfall -= add; }
    }
  }
  const totalBytes = out.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  assert.equal(shortfall, 0, 'WORKLOAD_BYTE_BUDGET_TOO_LARGE');
  assert.equal(totalBytes, bytes, 'WORKLOAD_BYTE_BUDGET_TOO_SMALL');
  assert.equal(out.length, files, 'WORKLOAD_FILE_COUNT_INVALID');
  assert.equal(new Set(out.map(file => file.path)).size, files, 'WORKLOAD_PATH_COLLISION');
  return { ctx, files: out };
}

function treeDigest(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const hash = crypto.createHash('sha256');
  for (const entry of sorted) hash.update(`${entry.sha256}\t${entry.size}\t${entry.path}\n`);
  return hash.digest('hex');
}

function summarize(files) {
  const entries = files.map(file => ({ path: file.path, size: Buffer.byteLength(file.content),
    sha256: crypto.createHash('sha256').update(file.content).digest('hex') }));
  const byKind = {};
  for (const [index, file] of files.entries()) {
    byKind[file.kind] ??= { files: 0, bytes: 0 };
    byKind[file.kind].files++; byKind[file.kind].bytes += entries[index].size;
  }
  return { entries, byKind, treeSha256: treeDigest(entries) };
}

function emptyPrivateDirectory(root) {
  assert(typeof root === 'string' && path.isAbsolute(root) && path.normalize(root) === root, 'WORKLOAD_ROOT_INVALID');
  const stat = fs.lstatSync(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o700 && fs.realpathSync(root) === root, 'WORKLOAD_ROOT_INVALID');
  assert.deepEqual(fs.readdirSync(root), [], 'WORKLOAD_ROOT_NOT_EMPTY');
}

// Writes the fixture into an existing empty private directory. The manifest is returned,
// not written into the tree, so it cannot become part of the imported source.
function generateWorkload({ root, sizeClass, files, bytes, seed = 'g-perf-1' }) {
  if (sizeClass !== undefined) {
    assert(Object.hasOwn(SIZE_CLASSES, sizeClass), 'WORKLOAD_CLASS_INVALID');
    assert(files === undefined && bytes === undefined, 'WORKLOAD_CLASS_INVALID');
    ({ files, bytes } = SIZE_CLASSES[sizeClass]);
  }
  emptyPrivateDirectory(root);
  const plan = planWorkload({ files, bytes, seed });
  const made = new Set();
  for (const file of plan.files) {
    const target = path.join(root, file.path);
    const directory = path.dirname(target);
    if (!made.has(directory)) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); made.add(directory); }
    fs.writeFileSync(target, file.content, { flag: 'wx', mode: 0o600 });
  }
  const summary = summarize(plan.files);
  return { format: 1, generator: GENERATOR, generatorSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    sizeClass: sizeClass ?? null, seed, files, bytes, modules: plan.ctx, byKind: summary.byKind,
    treeSha256: summary.treeSha256 };
}

// Reads a generated tree back from disk and recomputes its digest without following links.
function hashTree(root) {
  const entries = [];
  const visit = relative => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const rel = relative ? relative + '/' + name : name;
      const stat = fs.lstatSync(path.join(root, rel));
      if (stat.isDirectory()) visit(rel);
      else {
        assert(stat.isFile() && stat.nlink === 1, 'WORKLOAD_TREE_ENTRY_INVALID');
        const content = fs.readFileSync(path.join(root, rel));
        entries.push({ path: rel, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
      }
    }
  };
  visit('');
  return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), treeSha256: treeDigest(entries) };
}

// Deterministic "1% change": rewrite the revision constant of a seeded selection of code
// files. Sizes are unchanged; content hashes and the tree digest change.
function mutateWorkload({ root, manifest, fraction = 0.01, seed = 'g-perf-change-1', revision = 2 }) {
  assert(manifest && Number.isSafeInteger(manifest.files), 'WORKLOAD_MANIFEST_INVALID');
  assert(Number.isFinite(fraction) && fraction > 0 && fraction <= 0.5, 'WORKLOAD_FRACTION_INVALID');
  assert(Number.isSafeInteger(revision) && revision >= 2 && revision <= 9, 'WORKLOAD_REVISION_INVALID');
  const plan = planWorkload({ files: manifest.files, bytes: manifest.bytes, seed: manifest.seed });
  const patterns = [/static final int REVISION = 1;/, /static readonly revision = 1\b/, /_REVISION = 1\b/];
  const candidates = plan.files.filter(file => file.kind !== 'fixed' && patterns.some(re => re.test(file.content)));
  const count = Math.ceil(manifest.files * fraction);
  assert(candidates.length >= count, 'WORKLOAD_MUTATION_TOO_LARGE');
  const rng = rngFor(GENERATOR + ':mutate:' + seed);
  const order = candidates.map((file, index) => ({ file, key: rng(), index })).sort((a, b) => a.key - b.key || a.index - b.index);
  const changed = [];
  for (const { file } of order.slice(0, count)) {
    const target = path.join(root, file.path);
    const current = fs.readFileSync(target, 'utf8');
    assert.equal(current, file.content, 'WORKLOAD_TREE_CHANGED');
    const pattern = patterns.find(re => re.test(current));
    const next = current.replace(pattern, match => match.replace(/1(\b|;)/, `${revision}$1`));
    assert.notEqual(next, current); assert.equal(Buffer.byteLength(next), Buffer.byteLength(current));
    fs.writeFileSync(target, next, { mode: 0o600 });
    changed.push(file.path);
  }
  return { fraction, seed, revision, changedFiles: changed.length, changedPathsSha256:
    crypto.createHash('sha256').update(changed.sort().join('\n')).digest('hex') };
}

module.exports = { GENERATOR, SIZE_CLASSES, MIX, planWorkload, generateWorkload, hashTree, mutateWorkload, treeDigest,
  commentFill, rngFor };
