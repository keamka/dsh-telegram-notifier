import { chmod, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parse } from 'dotenv'
import { Document, isMap, parseDocument } from 'yaml'

const TELEGRAM_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readTelegramCredentials(text) {
  const environment = parse(text)
  const credentials = {}

  for (const key of TELEGRAM_KEYS) {
    const value = environment[key]?.trim()
    if (value === undefined || value === '' || value.includes('replace-with-')) {
      throw new Error(`${key} must be set in .env.secret`)
    }
    credentials[key] = value
  }

  return credentials
}

function renderCredentialDocument(text, credentials) {
  const document = text === undefined ? new Document({}) : parseDocument(text)
  if (document.errors.length > 0) {
    throw new Error('The existing DSH credentials file contains invalid YAML')
  }
  if (!isMap(document.contents)) {
    throw new Error('The existing DSH credentials file must contain a YAML mapping')
  }

  const version = document.get('version')
  if (version !== undefined && version !== 1) {
    throw new Error(`Unsupported DSH credentials version: ${String(version)}`)
  }

  const refs = document.get('refs', true)
  if (refs !== undefined && !isMap(refs)) {
    throw new Error('The refs field in the DSH credentials file must be a YAML mapping')
  }

  document.set('version', 1)
  for (const [key, value] of Object.entries(credentials)) {
    document.setIn(['refs', key], value)
  }
  return document.toString()
}

async function syncCredentials({
  envFile = join(PROJECT_ROOT, '.env.secret'),
  dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh')),
} = {}) {
  let source
  try {
    source = await readFile(envFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Missing ${envFile}; copy .env.example to .env.secret first`)
    }
    throw error
  }

  const credentials = readTelegramCredentials(source)
  const target = join(dshHome, '.credentials.yaml')

  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(envFile, 0o600)

  await withFileLock(target, async () => {
    let current
    try {
      current = await readFile(target, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }

    const next = renderCredentialDocument(current, credentials)
    await writeFileAtomic(target, next, { mode: 0o600, dirMode: 0o700 })
  })

  return target
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  syncCredentials()
    .then((target) => {
      console.log(`Telegram credentials saved to ${target}`)
    })
    .catch((error) => {
      console.error(`Could not sync Telegram credentials: ${error.message}`)
      process.exitCode = 1
    })
}

export {
  readTelegramCredentials,
  renderCredentialDocument,
  syncCredentials,
}
