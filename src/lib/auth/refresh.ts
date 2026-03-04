// Background token refresh manager
// Kimi: check every 60s, refresh when <5 min to expiry
// Codex: check once at startup, refresh when >8 days since last refresh
import {refreshKimiTokens} from './oauth-kimi.js'
import {refreshCodexTokens} from './oauth-codex.js'

export interface RefreshManager {
  stop(): void
}

let _instance: NodeJS.Timeout | null = null

export function startRefreshManager(): RefreshManager {
  // Stop any existing manager
  stopRefreshManager()

  // Codex: check once at startup (the function checks the 8-day threshold internally)
  refreshCodexTokens().catch(() => { /* non-fatal */ })

  // Kimi: check every 60 seconds
  _instance = setInterval(async () => {
    try {
      await refreshKimiTokens()
    } catch { /* non-fatal */ }
  }, 60_000)

  // Don't block process exit
  if (_instance.unref) _instance.unref()

  return {
    stop() { stopRefreshManager() },
  }
}

export function stopRefreshManager(): void {
  if (_instance) {
    clearInterval(_instance)
    _instance = null
  }
}
