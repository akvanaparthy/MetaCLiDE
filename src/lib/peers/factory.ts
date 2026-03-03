import type {PeerConfig} from '../../types.js'
import type {Peer} from './interface.js'
import {ClaudePeer} from './claude.js'
import {CodexPeer} from './codex.js'
import {KimiPeer} from './kimi.js'

export class PeerFactory {
  static create(config: PeerConfig, repoRoot: string, worktreePath: string): Peer {
    switch (config.provider) {
      case 'anthropic':
        return new ClaudePeer(config, repoRoot, worktreePath)
      case 'openai':
        return new CodexPeer(config, repoRoot, worktreePath)
      case 'moonshot':
        return new KimiPeer(config, repoRoot, worktreePath)
      default:
        // Attempt to load a plugin adapter
        throw new Error(
          `Unknown provider "${config.provider}" for peer "${config.id}". ` +
          `Install a plugin for this provider or use a built-in: anthropic, openai, moonshot.`
        )
    }
  }

  static async createAll(
    configs: PeerConfig[],
    repoRoot: string,
    worktreePathFn: (peerId: string) => string
  ): Promise<Map<string, Peer>> {
    const peers = new Map<string, Peer>()
    for (const config of configs) {
      const wtPath = worktreePathFn(config.id)
      peers.set(config.id, PeerFactory.create(config, repoRoot, wtPath))
    }
    return peers
  }
}
