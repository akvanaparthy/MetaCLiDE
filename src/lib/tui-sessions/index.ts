// TUI session persistence
// Stores sessions at ~/.metaclide/sessions/<workspace-hash>/<session-uuid>/
//   context.jsonl  — append-only conversation history
//   state.json     — metadata (conductor, project, timestamp, title)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type {MessageData} from '../../tui/Message.js'

const SESSIONS_DIR = path.join(os.homedir(), '.metaclide', 'sessions')

export interface SessionState {
  id: string
  workspaceHash: string
  conductorProvider: string
  conductorMode: string
  conductorDisplayName: string
  projectName: string
  title: string           // auto-generated from first user message
  createdAt: string
  updatedAt: string
}

export interface StoredSession {
  state: SessionState
  dir: string
}

function workspaceHash(repoRoot: string): string {
  return crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)
}

function sessionDir(repoRoot: string, sessionId: string): string {
  return path.join(SESSIONS_DIR, workspaceHash(repoRoot), sessionId)
}

// ── Write ──

export function createSession(repoRoot: string, state: Omit<SessionState, 'id' | 'workspaceHash' | 'createdAt' | 'updatedAt'>): SessionState {
  const id = crypto.randomUUID()
  const wHash = workspaceHash(repoRoot)
  const dir = sessionDir(repoRoot, id)
  fs.mkdirSync(dir, {recursive: true})

  const full: SessionState = {
    ...state,
    id,
    workspaceHash: wHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(full, null, 2))
  return full
}

export function updateSession(repoRoot: string, sessionId: string, updates: Partial<SessionState>): void {
  const dir = sessionDir(repoRoot, sessionId)
  const stateFile = path.join(dir, 'state.json')
  if (!fs.existsSync(stateFile)) return
  const current = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as SessionState
  const updated = {...current, ...updates, updatedAt: new Date().toISOString()}
  fs.writeFileSync(stateFile, JSON.stringify(updated, null, 2))
}

export function appendMessage(repoRoot: string, sessionId: string, message: MessageData): void {
  const dir = sessionDir(repoRoot, sessionId)
  if (!fs.existsSync(dir)) return
  const entry = {
    ...message,
    _ts: new Date().toISOString(),
  }
  fs.appendFileSync(path.join(dir, 'context.jsonl'), JSON.stringify(entry) + '\n')
}

// ── Read ──

export function loadMessages(repoRoot: string, sessionId: string): MessageData[] {
  const dir = sessionDir(repoRoot, sessionId)
  const file = path.join(dir, 'context.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try { return JSON.parse(l) as MessageData } catch { return null }
    })
    .filter((m): m is MessageData => m !== null)
}

export function loadState(repoRoot: string, sessionId: string): SessionState | null {
  const stateFile = path.join(sessionDir(repoRoot, sessionId), 'state.json')
  if (!fs.existsSync(stateFile)) return null
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as SessionState } catch { return null }
}

export function listSessions(repoRoot: string): StoredSession[] {
  const wDir = path.join(SESSIONS_DIR, workspaceHash(repoRoot))
  if (!fs.existsSync(wDir)) return []

  return fs.readdirSync(wDir)
    .map(id => {
      const dir = path.join(wDir, id)
      const stateFile = path.join(dir, 'state.json')
      if (!fs.existsSync(stateFile)) return null
      try {
        return {state: JSON.parse(fs.readFileSync(stateFile, 'utf8')) as SessionState, dir}
      } catch { return null }
    })
    .filter((s): s is StoredSession => s !== null)
    .sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt))
}

export function getLastSession(repoRoot: string): StoredSession | null {
  const all = listSessions(repoRoot)
  return all[0] ?? null
}

// ── Auto-title ──

export function autoTitle(firstUserMessage: string): string {
  const words = firstUserMessage.trim().split(/\s+/).slice(0, 6).join(' ')
  return words.length > 40 ? words.slice(0, 40) + '...' : words
}
