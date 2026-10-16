import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '../../../src/server/server.ts'

// Playwright's web server: the fixture project copied to a fresh directory
// (runs are written into it), served with the built UI on 127.0.0.1.
const dir = mkdtempSync(join(tmpdir(), 'litmus-ui-'))
cpSync(join(import.meta.dirname, 'project'), dir, { recursive: true })
const litmus = await serve({ configFile: join(dir, 'litmus.config.yaml'), port: Number(process.env['LITMUS_UI_PORT'] ?? 4318), uiDir: join(import.meta.dirname, '../../../ui/dist') })
process.stdout.write(`serving ${litmus.url} from ${dir}\n`)
const stop = async () => {
  await litmus.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
