import type {PeerConfig, PeerMessage, PeerEvent, PeerStatusUpdate, Capability} from '../../types.js'
import type {Peer} from './interface.js'
import {ClaudePeer} from './claude.js'
import {CodexPeer} from './codex.js'
import {KimiPeer} from './kimi.js'
import {AgenticApiPeer} from './agentic.js'
import {createPluginPeer as _createPluginPeer} from '../plugins/registry.js'
import {detectInstalledCLIs} from '../auth/session.js'

// Cache CLI detection (expensive PATH scan) — refreshed once per process
let _cliCache: Record<string, boolean> | null = null
function clis(): Record<string, boolean> {
  if (!_cliCache) _cliCache = detectInstalledCLIs()
  return _cliCache
}

// ---------------------------------------------------------------------------
// PluginProxy: lazy-loads the real plugin peer on the first send() call.
// This keeps PeerFactory.create() synchronous while still supporting async
// plugin loading.
// ---------------------------------------------------------------------------
class PluginProxy implements Peer {
  readonly id: string
  readonly mode: 'tool' | 'api'
  readonly role: 'conductor' | 'implementer'

  private readonly config: PeerConfig
  private readonly repoRoot: string
  private readonly worktreePath: string
  private real: Peer | null = null
  private loadPromise: Promise<Peer> | null = null

  constructor(config: PeerConfig, repoRoot: string, worktreePath: string) {
    this.id = config.id
    this.mode = config.type
    this.role = config.role
    this.config = config
    this.repoRoot = repoRoot
    this.worktreePath = worktreePath
  }

  private async load(): Promise<Peer> {
    if (this.real) return this.real
    if (!this.loadPromise) {
      this.loadPromise = _createPluginPeer(this.config, this.repoRoot, this.worktreePath).then(
        (peer) => {
          this.real = peer
          return peer
        },
      )
    }
    return this.loadPromise
  }

  capabilities(): Capability[] {
    // Return a conservative default before the real peer is loaded
    return this.real ? this.real.capabilities() : ['read', 'write', 'bash']
  }

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const peer = await this.load()
    yield* peer.send(msg)
  }

  async ackContract(version: number, hash: string): Promise<void> {
    const peer = await this.load()
    return peer.ackContract(version, hash)
  }

  async writeStatus(update: PeerStatusUpdate): Promise<void> {
    const peer = await this.load()
    return peer.writeStatus(update)
  }

  async shutdown(): Promise<void> {
    if (this.real) return this.real.shutdown()
    // If the real peer was never loaded, nothing to shut down
  }
}

// ---------------------------------------------------------------------------
// PeerFactory
// ---------------------------------------------------------------------------
export class PeerFactory {
  static create(config: PeerConfig, repoRoot: string, worktreePath: string): Peer {
    const installed = clis()

    switch (config.provider) {
      case 'anthropic':
        // Claude always uses the agent SDK — full agent loop without needing a CLI
        return new ClaudePeer(config, repoRoot, worktreePath)

      case 'openai':
        // Codex CLI available → full subprocess agent
        // No CLI → fall back to AgenticApiPeer (Kilocode-style loop over OpenAI API)
        if (installed['codex']) {
          return new CodexPeer(config, repoRoot, worktreePath)
        }
        return new AgenticApiPeer(config, repoRoot, worktreePath)

      case 'moonshot':
        // Kimi CLI available → full subprocess agent
        // No CLI → fall back to AgenticApiPeer over Moonshot's OpenAI-compatible API
        if (installed['kimi']) {
          return new KimiPeer(config, repoRoot, worktreePath)
        }
        return new AgenticApiPeer(config, repoRoot, worktreePath, 'https://api.moonshot.ai/v1')

      default:
        // Unknown provider with a baseURL → AgenticApiPeer (handles any OpenAI-compat endpoint)
        if ((config as unknown as {baseURL?: string}).baseURL) {
          return new AgenticApiPeer(config, repoRoot, worktreePath, (config as unknown as {baseURL: string}).baseURL)
        }
        // Try plugin registry via lazy proxy (keeps create() synchronous)
        return PeerFactory.createPluginPeer(config, repoRoot, worktreePath)
    }
  }

  /** Returns a PluginProxy that resolves the real peer adapter on first use. */
  static createPluginPeer(config: PeerConfig, repoRoot: string, worktreePath: string): Peer {
    return new PluginProxy(config, repoRoot, worktreePath)
  }

  static async createAll(
    configs: PeerConfig[],
    repoRoot: string,
    worktreePathFn: (peerId: string) => string,
  ): Promise<Map<string, Peer>> {
    const peers = new Map<string, Peer>()
    for (const config of configs) {
      const wtPath = worktreePathFn(config.id)
      peers.set(config.id, PeerFactory.create(config, repoRoot, wtPath))
    }
    return peers
  }
}
