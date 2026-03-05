import {describe, it, expect} from 'vitest'
import {Router} from '../src/lib/router/index.js'
import type {PeerConfig} from '../src/types.js'

const peers: PeerConfig[] = [
  {id: 'codex', displayName: 'Codex', type: 'tool', provider: 'openai', mode: 'oauth', contextFile: 'AGENTS.md', branch: 'agent/codex', role: 'conductor'},
  {id: 'kimi', displayName: 'Kimi', type: 'tool', provider: 'moonshot', mode: 'oauth', contextFile: 'AGENTS.md', branch: 'agent/kimi', role: 'implementer'},
]

describe('Router', () => {
  it('starts with zero costs', () => {
    const router = new Router(peers)
    expect(router.getTotalCost()).toBe(0)
    expect(router.getSessionCost('codex')).toBe(0)
  })

  it('records and tracks usage', () => {
    const router = new Router(peers)
    router.recordUsage('codex', 'openai', 0.05, 1)
    router.recordUsage('kimi', 'moonshot', 0.02, 1)

    expect(router.getSessionCost('codex')).toBe(0.05)
    expect(router.getSessionCost('kimi')).toBe(0.02)
    expect(router.getTotalCost()).toBeCloseTo(0.07)
  })

  it('tracks provider costs', () => {
    const router = new Router(peers)
    router.recordUsage('codex', 'openai', 0.05, 1)
    router.recordUsage('codex', 'openai', 0.03, 1)

    expect(router.getProviderCost('openai')).toBeCloseTo(0.08)
    expect(router.getProviderCost('moonshot')).toBe(0)
  })

  it('enforces per-agent budget', () => {
    const router = new Router(peers, {perProvider: {}, perAgentSession: 0.10, perPhase: 5})
    expect(router.isOverBudget('codex', 'openai')).toBe(false)

    router.recordUsage('codex', 'openai', 0.10, 1)
    expect(router.isOverBudget('codex', 'openai')).toBe(true)
    expect(router.isOverBudget('kimi', 'moonshot')).toBe(false)
  })

  it('enforces per-provider budget', () => {
    const router = new Router(peers, {perProvider: {openai: 0.05}, perAgentSession: 10, perPhase: 5})
    router.recordUsage('codex', 'openai', 0.05, 1)

    expect(router.isOverBudget('codex', 'openai')).toBe(true)
    expect(router.isOverBudget('kimi', 'moonshot')).toBe(false)
  })

  it('selectPeer prefers implementers', () => {
    const router = new Router(peers)
    const selected = router.selectPeer([])
    expect(selected?.id).toBe('kimi')
  })

  it('selectPeer excludes over-budget peers', () => {
    const router = new Router(peers, {perProvider: {}, perAgentSession: 0.01, perPhase: 5})
    router.recordUsage('kimi', 'moonshot', 0.01, 1)

    const selected = router.selectPeer([])
    expect(selected?.id).toBe('codex')
  })

  it('selectPeer returns null when all excluded', () => {
    const router = new Router(peers)
    const selected = router.selectPeer([], ['codex', 'kimi'])
    expect(selected).toBeNull()
  })

  it('summary aggregates by peer and provider', () => {
    const router = new Router(peers)
    router.recordUsage('codex', 'openai', 0.05, 1)
    router.recordUsage('kimi', 'moonshot', 0.02, 1)
    router.recordUsage('codex', 'openai', 0.03, 1)

    const s = router.summary()
    expect(s.totalCost).toBeCloseTo(0.10)
    expect(s.byPeer['codex']).toBeCloseTo(0.08)
    expect(s.byPeer['kimi']).toBeCloseTo(0.02)
    expect(s.byProvider['openai']).toBeCloseTo(0.08)
    expect(s.byProvider['moonshot']).toBeCloseTo(0.02)
  })
})
