// Peer session persistence — stores agent session IDs across restarts
// Claude: session_id (for --resume)
// Codex: thread_id (for codex exec resume)
import fs from 'node:fs'
import path from 'node:path'
import {orchRoot} from './paths.js'

export interface PeerSession {
  peerId: string
  claudeSessionId?: string
  codexThreadId?: string
  lastUpdated: string
}

export class SessionStore {
  private dir: string

  constructor(repoRoot: string) {
    this.dir = path.join(orchRoot(repoRoot), 'sessions')
    fs.mkdirSync(this.dir, {recursive: true})
  }

  read(peerId: string): PeerSession | null {
    const p = path.join(this.dir, `${peerId}.json`)
    if (!fs.existsSync(p)) return null
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as PeerSession
    } catch {
      return null
    }
  }

  write(session: PeerSession): void {
    const p = path.join(this.dir, `${session.peerId}.json`)
    fs.writeFileSync(p, JSON.stringify({...session, lastUpdated: new Date().toISOString()}, null, 2))
  }

  getClaudeSessionId(peerId: string): string | undefined {
    return this.read(peerId)?.claudeSessionId
  }

  setClaudeSessionId(peerId: string, sessionId: string): void {
    const existing = this.read(peerId) ?? {peerId, lastUpdated: ''}
    this.write({...existing, peerId, claudeSessionId: sessionId})
  }

  getCodexThreadId(peerId: string): string | undefined {
    return this.read(peerId)?.codexThreadId
  }

  setCodexThreadId(peerId: string, threadId: string): void {
    const existing = this.read(peerId) ?? {peerId, lastUpdated: ''}
    this.write({...existing, peerId, codexThreadId: threadId})
  }

  clear(peerId: string): void {
    const p = path.join(this.dir, `${peerId}.json`)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}
