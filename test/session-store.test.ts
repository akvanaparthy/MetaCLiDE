import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {SessionStore} from '../src/lib/orch/sessions.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaclide-test-'))
  // Create minimal .orch structure
  fs.mkdirSync(path.join(tmpDir, '.orch'), {recursive: true})
})

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

describe('SessionStore', () => {
  it('read returns null for unknown peer', () => {
    const store = new SessionStore(tmpDir)
    expect(store.read('unknown')).toBeNull()
  })

  it('stores and retrieves Claude session ID', () => {
    const store = new SessionStore(tmpDir)
    store.setClaudeSessionId('claude', 'sess-abc-123')

    expect(store.getClaudeSessionId('claude')).toBe('sess-abc-123')
  })

  it('stores and retrieves Codex thread ID', () => {
    const store = new SessionStore(tmpDir)
    store.setCodexThreadId('codex', 'thread-xyz')

    expect(store.getCodexThreadId('codex')).toBe('thread-xyz')
  })

  it('stores and retrieves Kimi session ID', () => {
    const store = new SessionStore(tmpDir)
    store.setKimiSessionId('kimi', 'kimi-session-456')

    expect(store.getKimiSessionId('kimi')).toBe('kimi-session-456')
  })

  it('preserves existing fields when updating', () => {
    const store = new SessionStore(tmpDir)
    store.setClaudeSessionId('claude', 'sess-1')
    store.setClaudeSessionId('claude', 'sess-2')

    const session = store.read('claude')
    expect(session).not.toBeNull()
    expect(session!.claudeSessionId).toBe('sess-2')
    expect(session!.lastUpdated).toBeTruthy()
  })

  it('clear removes session data', () => {
    const store = new SessionStore(tmpDir)
    store.setCodexThreadId('codex', 'thread-1')
    expect(store.getCodexThreadId('codex')).toBe('thread-1')

    store.clear('codex')
    expect(store.read('codex')).toBeNull()
  })

  it('multiple peers are independent', () => {
    const store = new SessionStore(tmpDir)
    store.setClaudeSessionId('claude', 'c-sess')
    store.setCodexThreadId('codex', 'x-thread')
    store.setKimiSessionId('kimi', 'k-sess')

    expect(store.getClaudeSessionId('claude')).toBe('c-sess')
    expect(store.getCodexThreadId('codex')).toBe('x-thread')
    expect(store.getKimiSessionId('kimi')).toBe('k-sess')

    // They don't interfere
    expect(store.getCodexThreadId('claude')).toBeUndefined()
  })
})
