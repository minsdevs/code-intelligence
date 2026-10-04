import { spawnSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { resolve, win32 } from 'node:path'

// Fixed relative to the integrity-verified runtime/ts-analyzer/dist placement.
// Never accept a helper path from analyzer configuration or search PATH.
export function readWindowsProtectedMaterial(file: string, privateKey: boolean): Buffer {
  const invalid = (): never => { throw new Error('Invalid analyzer transport configuration') }
  if (process.platform !== 'win32' || !/^[A-Za-z]:\\/.test(file) || win32.normalize(file) !== file
    || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file)) invalid()
  const executable = resolve(__dirname, '..', '..', 'native', 'windows', 'codeintel-boundary.exe')
  const before = lstatSync(executable, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) invalid()
  const name = Buffer.from(file, 'utf8')
  const input = Buffer.alloc(8 + name.length)
  input.writeUInt32BE(name.length)
  name.copy(input, 4)
  input.writeUInt32BE(65536, 4 + name.length)
  name.fill(0)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive']) {
    const actual = Object.keys(process.env).find(candidate => candidate.toLowerCase() === key.toLowerCase())
    if (actual) env[key] = process.env[actual]
  }
  const result = spawnSync(executable, [privateKey ? 'read-private' : 'read-public'], {
    input, env, shell: false, windowsHide: true, timeout: 15000, maxBuffer: 65536,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  input.fill(0)
  try {
    const after = lstatSync(executable, { bigint: true })
    if (result.error || result.status !== 0 || result.signal || result.stderr.length
      || !result.stdout.length || result.stdout.length > 65536 || !after.isFile() || after.isSymbolicLink()
      || after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) invalid()
    return result.stdout
  } catch { result.stdout?.fill(0); return invalid() }
}
