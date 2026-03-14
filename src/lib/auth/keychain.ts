// OS keychain storage via keytar, with fallback to local encrypted file
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

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

// Fallback: store in ~/.metaclide/credentials (AES-256-GCM encrypted)
const FALLBACK_FILE = path.join(os.homedir(), '.metaclide', 'credentials.enc')
const LEGACY_FILE = path.join(os.homedir(), '.metaclide', 'credentials.json')

// Derive a machine-specific key from hostname + username (not truly secret, but
// prevents casual reading — OS keychain is preferred when available)
function deriveKey(): Buffer {
  const seed = `metaclide:${os.hostname()}:${os.userInfo().username}`
  return crypto.scryptSync(seed, 'metaclide-salt', 32)
}

function encrypt(plaintext: string): string {
  const key = deriveKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Store as iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

function decrypt(data: string): string {
  const key = deriveKey()
  const [ivHex, tagHex, encHex] = data.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const encrypted = Buffer.from(encHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted) + decipher.final('utf8')
}

function readFallback(): Record<string, string> {
  // Try new encrypted format first
  if (fs.existsSync(FALLBACK_FILE)) {
    try {
      const raw = fs.readFileSync(FALLBACK_FILE, 'utf8')
      return JSON.parse(decrypt(raw))
    } catch { /* corrupted — start fresh */ }
  }
  // Migrate from legacy base64 format
  if (fs.existsSync(LEGACY_FILE)) {
    try {
      const raw = fs.readFileSync(LEGACY_FILE, 'utf8')
      const data = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
      // Re-save with real encryption
      writeFallback(data)
      fs.unlinkSync(LEGACY_FILE)
      return data
    } catch { /* corrupted */ }
  }
  return {}
}

function writeFallback(data: Record<string, string>): void {
  fs.mkdirSync(path.dirname(FALLBACK_FILE), {recursive: true})
  const encrypted = encrypt(JSON.stringify(data))
  fs.writeFileSync(FALLBACK_FILE, encrypted, {mode: 0o600})
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
