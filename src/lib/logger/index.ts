import fs from 'node:fs'
import path from 'node:path'
import {peerLogPath} from '../orch/paths.js'

export interface LogEntry {
  timestamp: string
  peer: string
  type: string
  content?: string
  toolName?: string
  toolInput?: unknown
  costUsd?: number
  turns?: number
  phase?: string
  taskId?: string
  [key: string]: unknown
}

export class PeerLogger {
  private logPath: string

  constructor(
    private readonly repoRoot: string,
    private readonly peerId: string
  ) {
    this.logPath = peerLogPath(repoRoot, peerId)
    // Ensure log directory exists
    fs.mkdirSync(path.dirname(this.logPath), {recursive: true})
  }

  append(entry: Record<string, unknown> & {type: string}): void {
    const full = {
      ...entry,
      timestamp: new Date().toISOString(),
      peer: this.peerId,
    }
    fs.appendFileSync(this.logPath, JSON.stringify(full) + '\n')
  }

  read(limit?: number): LogEntry[] {
    if (!fs.existsSync(this.logPath)) return []
    const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean)
    const entries = lines.map(l => {
      try {
        return JSON.parse(l) as LogEntry
      } catch {
        return null
      }
    }).filter(Boolean) as LogEntry[]

    if (limit !== undefined) return entries.slice(-limit)
    return entries
  }

  tail(n = 20): LogEntry[] {
    return this.read(n)
  }

  *stream(): Generator<LogEntry> {
    if (!fs.existsSync(this.logPath)) return
    const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        yield JSON.parse(line) as LogEntry
      } catch {
        // skip malformed
      }
    }
  }
}

export class SessionLogger {
  private loggers: Map<string, PeerLogger> = new Map()

  constructor(private readonly repoRoot: string) {}

  for(peerId: string): PeerLogger {
    if (!this.loggers.has(peerId)) {
      this.loggers.set(peerId, new PeerLogger(this.repoRoot, peerId))
    }
    return this.loggers.get(peerId)!
  }

  logAll(entry: Record<string, unknown> & {type: string}, peerIds: string[]): void {
    for (const id of peerIds) {
      this.for(id).append(entry)
    }
  }
}
