// Codex CLI OAuth — PKCE browser flow + device code fallback
// Endpoints: https://auth.openai.com
// Client ID: app_EMoamEEZ73f0CkXaXp7hrann

import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_HOST = 'https://auth.openai.com'
const CALLBACK_PORT = 1455
const SCOPES = 'openid profile email offline_access'

export interface CodexTokens {
  auth_mode: 'chatgpt'
  openai_api_key?: string
  tokens?: {
    id_token: string
    access_token: string
    refresh_token: string
  }
  last_refresh?: string
}

function codexAuthPath(): string {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  return path.join(home, 'auth.json')
}

function generatePKCE(): {verifier: string; challenge: string} {
  const verifier = crypto.randomBytes(64).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return {verifier, challenge}
}

// ── Read/write tokens ──

export function readCodexTokens(): CodexTokens | null {
  const p = codexAuthPath()
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function writeCodexTokens(tokens: CodexTokens): void {
  const p = codexAuthPath()
  fs.mkdirSync(path.dirname(p), {recursive: true})
  fs.writeFileSync(p, JSON.stringify(tokens, null, 2), {mode: 0o600})
}

export function getCodexApiKey(): string | null {
  // Check env first
  const envKey = (process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim()
  if (envKey) return envKey

  const tokens = readCodexTokens()
  return tokens?.openai_api_key ?? null
}

export function hasCodexSession(): boolean {
  return getCodexApiKey() !== null
}

// ── Token exchange: id_token → API key ──

async function exchangeForApiKey(idToken: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: CLIENT_ID,
    requested_token: 'openai-api-key',
    subject_token: idToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
  })

  const res = await fetch(`${AUTH_HOST}/oauth/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: body.toString(),
  })

  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as {access_token: string}
  return data.access_token
}

// ── Exchange auth code for tokens ──

async function exchangeAuthCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{id_token: string; access_token: string; refresh_token: string}> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  })

  const res = await fetch(`${AUTH_HOST}/oauth/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: body.toString(),
  })

  if (!res.ok) throw new Error(`Auth code exchange failed: ${res.status} ${await res.text()}`)
  return await res.json() as {id_token: string; access_token: string; refresh_token: string}
}

// ── Flow A: PKCE Browser Flow ──

export interface OAuthProgress {
  type: 'browser_opened' | 'waiting' | 'success' | 'error'
  message: string
  url?: string
}

export async function loginCodexBrowser(
  onProgress: (event: OAuthProgress) => void
): Promise<string> {
  const {verifier, challenge} = generatePKCE()
  const state = crypto.randomBytes(16).toString('hex')
  const redirectUri = `http://localhost:${CALLBACK_PORT}/auth/callback`

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`)

      if (url.pathname === '/auth/callback') {
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')

        if (returnedState !== state) {
          res.writeHead(400, {'Content-Type': 'text/html'})
          res.end('<h1>Invalid state parameter</h1>')
          server.close()
          reject(new Error('OAuth state mismatch'))
          return
        }

        if (!code) {
          res.writeHead(400, {'Content-Type': 'text/html'})
          res.end('<h1>No authorization code received</h1>')
          server.close()
          reject(new Error('No authorization code'))
          return
        }

        res.writeHead(200, {'Content-Type': 'text/html'})
        res.end('<h1>Success! You can close this window.</h1><script>window.close()</script>')

        try {
          onProgress({type: 'waiting', message: 'Exchanging tokens...'})
          const tokens = await exchangeAuthCode(code, verifier, redirectUri)
          const apiKey = await exchangeForApiKey(tokens.id_token)

          writeCodexTokens({
            auth_mode: 'chatgpt',
            openai_api_key: apiKey,
            tokens: {
              id_token: tokens.id_token,
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
            },
            last_refresh: new Date().toISOString(),
          })

          onProgress({type: 'success', message: 'Codex OAuth login successful'})
          server.close()
          resolve(apiKey)
        } catch (err) {
          server.close()
          reject(err)
        }
      } else if (url.pathname === '/cancel') {
        res.writeHead(200, {'Content-Type': 'text/html'})
        res.end('<h1>Login cancelled</h1>')
        server.close()
        reject(new Error('Login cancelled by user'))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    server.listen(CALLBACK_PORT, () => {
      const authUrl = `${AUTH_HOST}/oauth/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        scope: SCOPES,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString()

      onProgress({type: 'browser_opened', message: 'Opening browser for OpenAI login...', url: authUrl})

      // Open browser
      import('open').then(mod => mod.default(authUrl)).catch(() => {
        onProgress({type: 'waiting', message: `Open this URL in your browser:\n${authUrl}`})
      })
    })

    server.on('error', (err) => {
      reject(new Error(`Could not start OAuth server on port ${CALLBACK_PORT}: ${err.message}`))
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close()
      reject(new Error('OAuth login timed out (5 minutes)'))
    }, 5 * 60 * 1000)
  })
}

// ── Flow B: Device Code Flow ──

export async function loginCodexDevice(
  onProgress: (event: OAuthProgress) => void
): Promise<string> {
  // Step 1: Request user code
  const ucRes = await fetch(`${AUTH_HOST}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({client_id: CLIENT_ID}),
  })

  if (!ucRes.ok) throw new Error(`Device auth request failed: ${ucRes.status}`)
  const ucData = await ucRes.json() as {device_auth_id: string; user_code: string; interval: string}

  const verificationUrl = 'https://auth.openai.com/codex/device'
  onProgress({
    type: 'browser_opened',
    message: `Go to ${verificationUrl} and enter code: ${ucData.user_code}`,
    url: verificationUrl,
  })

  // Open browser
  try {
    const open = await import('open')
    await open.default(verificationUrl)
  } catch { /* browser open failed, user has the URL */ }

  // Step 2: Poll for token
  const interval = Math.max(parseInt(ucData.interval, 10) || 5, 5) * 1000
  const maxWait = 15 * 60 * 1000
  const start = Date.now()

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, interval))

    onProgress({type: 'waiting', message: `Waiting for authorization... (code: ${ucData.user_code})`})

    const pollRes = await fetch(`${AUTH_HOST}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        device_auth_id: ucData.device_auth_id,
        user_code: ucData.user_code,
      }),
    })

    if (pollRes.status === 403 || pollRes.status === 404) {
      continue // Still pending
    }

    if (pollRes.ok) {
      const pollData = await pollRes.json() as {
        authorization_code: string
        code_verifier: string
        code_challenge: string
      }

      onProgress({type: 'waiting', message: 'Exchanging tokens...'})

      const redirectUri = 'https://auth.openai.com/deviceauth/callback'
      const tokens = await exchangeAuthCode(pollData.authorization_code, pollData.code_verifier, redirectUri)
      const apiKey = await exchangeForApiKey(tokens.id_token)

      writeCodexTokens({
        auth_mode: 'chatgpt',
        openai_api_key: apiKey,
        tokens: {
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
        },
        last_refresh: new Date().toISOString(),
      })

      onProgress({type: 'success', message: 'Codex OAuth login successful'})
      return apiKey
    }

    // Unexpected error
    const errText = await pollRes.text()
    throw new Error(`Device auth poll failed: ${pollRes.status} ${errText}`)
  }

  throw new Error('Device code expired (15 minutes)')
}

// ── Token Refresh ──

export async function refreshCodexTokens(): Promise<string | null> {
  const stored = readCodexTokens()
  if (!stored?.tokens?.refresh_token) return null

  // Check if refresh is needed (>8 days since last refresh)
  if (stored.last_refresh) {
    const lastRefresh = new Date(stored.last_refresh).getTime()
    const eightDays = 8 * 24 * 60 * 60 * 1000
    if (Date.now() - lastRefresh < eightDays) return stored.openai_api_key ?? null
  }

  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: stored.tokens.refresh_token,
      scope: 'openid profile email',
    })

    const res = await fetch(`${AUTH_HOST}/oauth/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(Object.fromEntries(body)),
    })

    if (!res.ok) return null

    const data = await res.json() as {id_token: string; access_token: string; refresh_token: string}
    const apiKey = await exchangeForApiKey(data.id_token)

    writeCodexTokens({
      auth_mode: 'chatgpt',
      openai_api_key: apiKey,
      tokens: {
        id_token: data.id_token,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      },
      last_refresh: new Date().toISOString(),
    })

    return apiKey
  } catch {
    return stored.openai_api_key ?? null
  }
}
