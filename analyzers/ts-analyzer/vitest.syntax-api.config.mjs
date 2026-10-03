// Direct service calls only. No Nest application, transport or server is started.
import parser from './vitest.parser.config.mjs'

export default {
  ...parser,
  test: { ...parser.test, include: [...parser.test.include, 'src/analyze.service.test.ts'] },
}
