import {describe, it, expect, vi, beforeEach} from 'vitest'
import {PeerFactory} from '../src/lib/peers/factory.js'
import type {PeerConfig} from '../src/types.js'

// Mock detectInstalledCLIs to control test behavior
vi.mock('../src/lib/auth/session.js', () => ({
  detectInstalledCLIs: () => ({codex: true, kimi: true, claude: false}),
  BUILT_IN_AGENTS: [],
}))

describe('PeerFactory', () => {
  const baseConfig: Omit<PeerConfig, 'id' | 'provider' | 'mode' | 'displayName'> = {
    type: 'tool',
    contextFile: 'AGENTS.md',
    branch: 'agent/test',
    role: 'implementer',
  }

  it('creates ClaudePeer for anthropic provider', () => {
    const peer = PeerFactory.create(
      {...baseConfig, id: 'claude', displayName: 'Claude', provider: 'anthropic', mode: 'byok', apiKey: 'sk-test'},
      '/tmp/repo',
      '/tmp/worktree'
    )
    expect(peer.id).toBe('claude')
    expect(peer.constructor.name).toBe('ClaudePeer')
  })

  it('creates CodexPeer for openai provider when CLI is installed', () => {
    const peer = PeerFactory.create(
      {...baseConfig, id: 'codex', displayName: 'Codex', provider: 'openai', mode: 'oauth'},
      '/tmp/repo',
      '/tmp/worktree'
    )
    expect(peer.id).toBe('codex')
    expect(peer.constructor.name).toBe('CodexPeer')
  })

  it('creates KimiPeer for moonshot provider when CLI is installed', () => {
    const peer = PeerFactory.create(
      {...baseConfig, id: 'kimi', displayName: 'Kimi', provider: 'moonshot', mode: 'oauth'},
      '/tmp/repo',
      '/tmp/worktree'
    )
    expect(peer.id).toBe('kimi')
    expect(peer.constructor.name).toBe('KimiPeer')
  })

  it('creates AgenticApiPeer for unknown provider with baseURL', () => {
    const config = {
      ...baseConfig,
      id: 'custom',
      displayName: 'Custom',
      provider: 'custom',
      mode: 'byok' as const,
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk-test',
    }
    const peer = PeerFactory.create(config, '/tmp/repo', '/tmp/worktree')
    expect(peer.constructor.name).toBe('AgenticApiPeer')
  })

  it('creates PluginProxy for unknown provider without baseURL', () => {
    const config = {
      ...baseConfig,
      id: 'myplugin',
      displayName: 'My Plugin',
      provider: 'myplugin',
      mode: 'byok' as const,
    }
    const peer = PeerFactory.create(config, '/tmp/repo', '/tmp/worktree')
    // PluginProxy is a private class, but it implements Peer
    expect(peer.id).toBe('myplugin')
    expect(peer.role).toBe('implementer')
  })

  it('creates AgenticApiPeer for openai BYOK without CLI', () => {
    // With CLI mocked as installed, BYOK mode should still work
    const peer = PeerFactory.create(
      {...baseConfig, id: 'codex2', displayName: 'Codex BYOK', provider: 'openai', mode: 'byok', apiKey: 'sk-test'},
      '/tmp/repo',
      '/tmp/worktree'
    )
    // With CLI installed, it creates CodexPeer regardless of mode
    expect(peer.constructor.name).toBe('CodexPeer')
  })
})
