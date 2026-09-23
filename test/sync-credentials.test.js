import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readTelegramCredentials,
  renderCredentialDocument,
  syncCredentials,
} from '../scripts/sync-credentials.js'

test('readTelegramCredentials requires both non-placeholder values', () => {
  assert.deepEqual(readTelegramCredentials([
    'TELEGRAM_BOT_TOKEN="123:abc"',
    'TELEGRAM_CHAT_ID=-100123',
  ].join('\n')), {
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '-100123',
  })

  assert.throws(
    () => readTelegramCredentials('TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID='),
    /TELEGRAM_CHAT_ID must be set/,
  )
})

test('renderCredentialDocument preserves unrelated credentials and records', () => {
  const result = renderCredentialDocument([
    'version: 1',
    'refs:',
    '  EXISTING_KEY: keep-me # keep this comment',
    'records:',
    '  owner/id:',
    '    kind: api-key',
    '',
  ].join('\n'), {
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '-100123',
  })

  assert.match(result, /EXISTING_KEY: keep-me # keep this comment/)
  assert.match(result, /TELEGRAM_BOT_TOKEN: 123:abc/)
  assert.match(result, /TELEGRAM_CHAT_ID: "-100123"/)
  assert.match(result, /owner\/id:/)
})

test('syncCredentials writes a private DSH credential file', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-notifier-'))
  context.after(() => rm(root, { recursive: true, force: true }))

  const envFile = join(root, '.env.secret')
  const dshHome = join(root, '.dsh')
  await writeFile(envFile, 'TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID=456\n')

  const target = await syncCredentials({ envFile, dshHome })
  const content = await readFile(target, 'utf8')
  const metadata = await stat(target)

  assert.match(content, /TELEGRAM_BOT_TOKEN: 123:abc/)
  assert.match(content, /TELEGRAM_CHAT_ID: "456"/)
  if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o600)
})
