// Kimi Code OAuth — Device code flow (RFC 8628)
// Endpoints: https://auth.kimi.com
// Client ID: 17e5f671-d194-4dfb-9706-5516cb48c098

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const AUTH_HOST = process.env.KIMI_CODE_OAUTH_HOST ?? 'https://auth.kimi.com'
const REFRESH_THRESHOLD = 300 // seconds — refresh if <5 min to expiry

export interface KimiTokens {
  access_token: string
  refresh_token: string
  expires_at: number  // Unix timestamp (seconds)
  scope: string
  token_type: string
}

// ── Platform headers required on all Kimi OAuth requests ──

function deviceIdPath(): string {
  const shareDir = process.env.KIMI_SHARE_DIR ?? path.join(os.homedir(), '.metaclide')
  return path.join(shareDir, 'device_id')
}

function getOrCreateDeviceId(): string {
  const p = deviceIdPath()
  if (fs.existsSync(p)) {
    return fs.readFileSync(p, 'utf8').trim()
  }
  const id = crypto.randomUUID().replace(/-/g, '')
  fs.mkdirSync(path.dirname(p), {recursive: true})
  fs.writeFileSync(p, id)
  return id
}

function platformHeaders(): Record<string, string> {
  return {
    'X-Msh-Platform': 'metaclide',
    'X-Msh-Version': '0.1.0',
    'X-Msh-Device-Name': os.hostname(),
    'X-Msh-Device-Model': os.arch(),
    'X-Msh-Os-Version': os.version(),
    'X-Msh-Device-Id': getOrCreateDeviceId(),
  }
}

// ── Read/write tokens ──

function kimiCredPath(): string {
  return path.join(os.homedir(), '.kimi', 'credentials', 'kimi-code.json')
}

export function readKimiTokens(): KimiTokens | null {
  const p = kimiCredPath()
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function writeKimiTokens(tokens: KimiTokens): void {
  const p = kimiCredPath()
  fs.mkdirSync(path.dirname(p), {recursive: true})
  fs.writeFileSync(p, JSON.stringify(tokens, null, 2), {mode: 0o600})
}

export function getKimiAccessToken(): string | null {
  // Check env first
  const envKey = (process.env.MOONSHOT_API_KEY ?? '').trim()
  if (envKey) return envKey

  const tokens = readKimiTokens()
  if (!tokens) return null

  // Check if expired
  const now = Math.floor(Date.now() / 1000)
  if (tokens.expires_at && tokens.expires_at < now) return null

  return tokens.access_token
}

export function hasKimiSession(): boolean {
  return getKimiAccessToken() !== null
}

// ── Device Code Flow ──

export interface OAuthProgress {
  type: 'browser_opened' | 'waiting' | 'success' | 'error'
  message: string
  url?: string
  userCode?: string
}

export async function loginKimiDevice(
  onProgress: (event: OAuthProgress) => void
): Promise<string> {
  // Step 1: Request device authorization
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...platformHeaders(),
  }

  const daRes = await fetch(`${AUTH_HOST}/api/oauth/device_authorization`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({client_id: CLIENT_ID}).toString(),
  })

  if (!daRes.ok) throw new Error(`Kimi device auth request failed: ${daRes.status}`)

  const daData = await daRes.json() as {
    user_code: string
    device_code: string
    verification_uri: string
    verification_uri_complete: string
    expires_in: number
    interval: number
  }

  onProgress({
    type: 'browser_opened',
    message: `Enter code: ${daData.user_code}`,
    url: daData.verification_uri_complete,
    userCode: daData.user_code,
  })

  // Open browser
  try {
    const open = await import('open')
    await open.default(daData.verification_uri_complete)
  } catch { /* browser open failed, user has the URL */ }

  // Step 2: Poll for token
  const interval = Math.max(daData.interval || 5, 3) * 1000
  const maxWait = (daData.expires_in || 900) * 1000
  const start = Date.now()

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, interval))

    onProgress({type: 'waiting', message: `Waiting for authorization... (code: ${daData.user_code})`})

    const pollRes = await fetch(`${AUTH_HOST}/api/oauth/token`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: daData.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    })

    if (pollRes.status >= 500) {
      throw new Error(`Kimi server error: ${pollRes.status}`)
    }

    if (!pollRes.ok) {
      const errData = await pollRes.json().catch(() => ({})) as {error?: string}
      if (errData.error === 'authorization_pending') continue
      if (errData.error === 'expired_token') {
        throw new Error('Device code expired. Please try again.')
      }
      continue // Other client errors — keep polling
    }

    // Success
    const tokenData = await pollRes.json() as {
      access_token: string
      refresh_token: string
      expires_in: number
      scope: string
      token_type: string
    }

    const tokens: KimiTokens = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + tokenData.expires_in,
      scope: tokenData.scope,
      token_type: tokenData.token_type,
    }

    writeKimiTokens(tokens)
    onProgress({type: 'success', message: 'Kimi OAuth login successful'})
    return tokens.access_token
  }

  throw new Error('Device code expired (timeout)')
}

// ── Token Refresh ──

export async function refreshKimiTokens(): Promise<string | null> {
  const stored = readKimiTokens()
  if (!stored?.refresh_token) return null

  // Check if refresh is needed
  const now = Math.floor(Date.now() / 1000)
  const timeLeft = stored.expires_at - now
  if (timeLeft > REFRESH_THRESHOLD) return stored.access_token

  try {
    const res = await fetch(`${AUTH_HOST}/api/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...platformHeaders(),
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: stored.refresh_token,
      }).toString(),
    })

    if (res.status === 401 || res.status === 403) {
      // Token revoked — delete stored tokens
      try { fs.unlinkSync(kimiCredPath()) } catch {}
      return null
    }

    if (!res.ok) return stored.access_token // Use existing token, hope for the best

    const data = await res.json() as {
      access_token: string
      refresh_token: string
      expires_in: number
      scope: string
      token_type: string
    }

    const tokens: KimiTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
      scope: data.scope,
      token_type: data.token_type,
    }

    writeKimiTokens(tokens)
    return tokens.access_token
  } catch {
    return stored.access_token
  }
}
