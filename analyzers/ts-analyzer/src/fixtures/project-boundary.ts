import type { AnalyzeFile } from '../types'

/** Three meaningful files straddle the old 500-file split; fillers carry no semantics. */
export function projectBoundaryFixture(): AnalyzeFile[] {
  return [
    { path: 'a-main.ts', content: "import { NestFactory } from '@nestjs/core'; const app = await NestFactory.create(AppModule); app.setGlobalPrefix('api');" },
    {
      path: 'b-users.service.ts',
      content: "import { Injectable } from '@nestjs/common'; @Injectable() export class UsersService { list() { return []; } }",
    },
    ...Array.from({ length: 498 }, (_, i) => ({ path: `c-${String(i).padStart(3, '0')}.ts`, content: 'export {}' })),
    {
      path: 'z-users.controller.ts',
      content: "import { Controller, Get } from '@nestjs/common'; import { UsersService } from './b-users.service'; @Controller('users') export class UsersController { constructor(private readonly users: UsersService) {} @Get() list() { return this.users.list(); } }",
    },
  ]
}
