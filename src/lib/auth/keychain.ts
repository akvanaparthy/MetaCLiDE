// OS keychain storage via keytar, with fallback to local encrypted file
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SERVICE = 'metaclide'

// Lazy-load keytar to avoid hard crash if native bindings aren't compiled
let keytar: {
  getPassword: (service: string, account: string) => Promise<string | null>
  setPassword: (service: string, account: string, password: string) => Promise<void>
  deletePassword: (service: string, account: string) => Promise<boolean>
  findCredentials: (service: string) => Promise<Array<{account: string; password: string}>>
} | null = null

async function getKeytar() {
  if (keytar !== null) return keytar
  try {
    const mod = await import('keytar')
    keytar = mod.default ?? (mod as unknown as typeof keytar)
  } catch {
    keytar = null
  }
  return keytar
}

// Fallback: store in ~/.metaclide/credentials (obfuscated, not truly encrypted)
const FALLBACK_FILE = path.join(os.homedir(), '.metaclide', 'credentials.json')

function readFallback(): Record<string, string> {
  if (!fs.existsSync(FALLBACK_FILE)) return {}
  try {
    const raw = fs.readFileSync(FALLBACK_FILE, 'utf8')
    const buf = Buffer.from(raw, 'base64')
    const decrypted = buf.toString('utf8')
    return JSON.parse(decrypted)
  } catch {
    return {}
  }
}

function writeFallback(data: Record<string, string>): void {
  fs.mkdirSync(path.dirname(FALLBACK_FILE), {recursive: true})
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64')
  fs.writeFileSync(FALLBACK_FILE, encoded, {mode: 0o600})
}

function fallbackKey(account: string): string {
  return `${SERVICE}:${account}`
}

export async function storeCredential(agentId: string, apiKey: string): Promise<void> {
  const kt = await getKeytar()
  if (kt) {
    await kt.setPassword(SERVICE, agentId, apiKey)
  } else {
    const data = readFallback()
    data[fallbackKey(agentId)] = apiKey
    writeFallback(data)
  }
}

export async function getCredential(agentId: string): Promise<string | null> {
  const kt = await getKeytar()
  if (kt) {
    return kt.getPassword(SERVICE, agentId)
  }
  const data = readFallback()
  return data[fallbackKey(agentId)] ?? null
}

export async function deleteCredential(agentId: string): Promise<void> {
  const kt = await getKeytar()
  if (kt) {
    await kt.deletePassword(SERVICE, agentId)
  } else {
    const data = readFallback()
    delete data[fallbackKey(agentId)]
    writeFallback(data)
  }
}

export async function listStoredAgents(): Promise<string[]> {
  const kt = await getKeytar()
  if (kt) {
    const creds = await kt.findCredentials(SERVICE)
    return creds.map(c => c.account)
  }
  const data = readFallback()
  return Object.keys(data).map(k => k.replace(`${SERVICE}:`, ''))
}

export async function isKeytarAvailable(): Promise<boolean> {
  return (await getKeytar()) !== null
}
