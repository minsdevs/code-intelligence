import { describe, expect, it } from 'vitest'
import { extract } from './tree'

describe('extract', () => {
  it('extracts FastAPI endpoints, symbols and SQLAlchemy entities', () => {
    const result = extract([
      {
        path: 'app/main.py',
        content: [
          'from fastapi import FastAPI',
          'from sqlalchemy.orm import declarative_base',
          'Base = declarative_base()',
          'app = FastAPI()',
          '@app.get("/items/{item_id}")',
          'def get_item(item_id: int):',
          '    return {"id": item_id}',
          'class Product(Base):',
          '    __tablename__ = "products"',
          '    id = Column(Integer, primary_key=True)',
          'def helper():',
          '    pass',
        ].join('\n'),
      },
    ])
    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      'GET /items/{item_id}',
    ])
    expect(result.entities.map((entity) => `${entity.name}:${entity.tableName}`)).toEqual(['Product:products'])
    expect(result.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`).sort()).toEqual(
      ['FUNCTION:get_item', 'FUNCTION:helper'].sort(),
    )
  })

  it('extracts Flask route with explicit methods', () => {
    const result = extract([
      {
        path: 'server.py',
        content: [
          'from flask import Flask',
          'app = Flask(__name__)',
          '@app.route("/api/users", methods=["GET", "POST"])',
          'def users():',
          '    return "ok"',
        ].join('\n'),
      },
    ])
    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort()).toEqual([
      'GET /api/users',
      'POST /api/users',
    ])
  })

  it('extracts Django urlpatterns', () => {
    const result = extract([
      {
        path: 'config/urls.py',
        content: [
          "from django.urls import path",
          'urlpatterns = [',
          '    path("admin/", admin.site.urls),',
          '    path("api/items/", views.items),',
          ']',
        ].join('\n'),
      },
    ])
    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort()).toEqual([
      'ANY /admin/',
      'ANY /api/items/',
    ])
  })

  it('extracts gin and net/http endpoints', () => {
    const result = extract([
      {
        path: 'cmd/server/main.go',
        content: [
          'package main',
          'import ("net/http"; "github.com/gin-gonic/gin")',
          'func main() {',
          '  r := gin.Default()',
          '  r.GET("/ping", pingHandler)',
          '  r.POST("/items/:id", createItem)',
          '  http.HandleFunc("/health", health)',
          '}',
          'type Server struct { Addr string }',
          'func pingHandler(c *gin.Context) {}',
          'func createItem(c *gin.Context) {}',
          'func health(w http.ResponseWriter, r *http.Request) {}',
          'func (s *Server) Listen() {}',
        ].join('\n'),
      },
    ])
    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort()).toEqual([
      'ANY /health',
      'GET /ping',
      'POST /items/:id',
    ])
    expect(result.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`).sort()).toContain('CLASS:Server')
    expect(result.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`).sort()).toContain('METHOD:Listen')
  })

  it('extracts Vue SFC components with api calls', () => {
    const result = extract([
      {
        path: 'src/views/About.vue',
        content: [
          '<script setup lang="ts">',
          'const data = await fetch("/api/about")',
          'const res = await axios.get("/api/settings")',
          '</script>',
          '<template><div>about</div></template>',
        ].join('\n'),
      },
    ])
    expect(result.components.map((component) => component.name)).toEqual(['About'])
    expect(result.apiCalls.map((call) => `${call.method} ${call.url}`).sort()).toEqual([
      'GET /api/about',
      'GET /api/settings',
    ])
  })

  it('extracts SvelteKit routes from +page.svelte files', () => {
    const result = extract([
      { path: 'src/routes/+page.svelte', content: '<script>let x = 1</script><h1>home</h1>' },
      { path: 'src/routes/about/+page.svelte', content: '<h1>about</h1>' },
      { path: 'src/routes/products/[slug]/+page.svelte', content: '<h1>product</h1>' },
    ])
    expect(result.routes.map((route) => route.path).sort()).toEqual(['/', '/about', '/products/:slug'])
  })

  it('resolves intra-project python imports', () => {
    const result = extract([
      { path: 'pkg/util.py', content: 'def helper():\n    pass\n' },
      { path: 'app.py', content: 'from pkg.util import helper\nhelper()\n' },
    ])
    expect(result.imports).toContainEqual({
      fromPath: 'app.py',
      toPath: 'pkg/util.py',
      imported: 'helper',
    })
  })
})


describe('per-file outcomes', () => {
  it('distinguishes complete parser runs, recovered syntax, and script-only extraction', () => {
    const result = extract([
      { path: 'empty.py', content: '' },
      { path: 'broken.py', content: 'def broken(:' },
      { path: 'View.vue', content: '<template><div /></template>' },
      { path: 'unsupported.rs', content: 'fn main() {}' },
    ])
    expect(result.fileOutcomes).toEqual([
      { path: 'empty.py', status: 'SUCCESS', reason: 'PYTHON_PARSED' },
      { path: 'broken.py', status: 'PARTIAL', reason: 'RECOVERED_SYNTAX_ERRORS' },
      { path: 'View.vue', status: 'PARTIAL', reason: 'SCRIPT_ONLY_EXTRACTION' },
      { path: 'unsupported.rs', status: 'UNSUPPORTED', reason: 'SOURCE_LANGUAGE_UNSUPPORTED' },
    ])
  })
})
