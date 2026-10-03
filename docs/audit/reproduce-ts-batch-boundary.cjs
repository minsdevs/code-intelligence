// Synthetic-only regression: real production Nest HTTP stack on a random loopback port.
// Run after: npm --prefix analyzers/ts-analyzer run build
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const analyzerRequire = createRequire(path.resolve(__dirname, '../../analyzers/ts-analyzer/package.json'));
analyzerRequire('reflect-metadata');
const { NestFactory } = analyzerRequire('@nestjs/core');
const { json } = analyzerRequire('express');
const { AppModule } = analyzerRequire('./dist/app.module');
const { projectBoundaryFixture } = analyzerRequire('./dist/fixtures/project-boundary');

async function check() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.use(json({ limit: '10mb' }));
  try {
    await app.listen(0, '127.0.0.1');
    const files = projectBoundaryFixture();
    const response = await fetch(`${await app.getUrl()}/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files })
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.deepEqual(result.endpoints.map((endpoint) => endpoint.path), ['/api/users']);
    assert(result.edges.some((edge) => edge.type === 'CALLS'
      && edge.sourceKey === 'ts:z-users.controller.ts#UsersController.list'
      && edge.targetKey === 'ts:b-users.service.ts#UsersService.list'));
    console.log(JSON.stringify({ syntheticFiles: files.length, endpoints: ['/api/users'], controllerServiceCall: true, result: 'PASS' }));
  } finally {
    await app.close();
  }
}
check().catch((error) => { console.error(error); process.exitCode = 1; });
