import {Command, Args, Flags} from '@oclif/core'
import {BUILT_IN_AGENTS} from '../../lib/auth/session.js'
import {storeCredential} from '../../lib/auth/keychain.js'
import {requireOrch} from '../../lib/orch/index.js'
import type {PeerConfig} from '../../types.js'
import * as readline from 'node:readline/promises'
import {stdin as input, stdout as output} from 'node:process'

export default class AgentsAdd extends Command {
  static description = 'Add an agent to the active peer session'

  static examples = [
    '<%= config.bin %> agents add claude',
    '<%= config.bin %> agents add codex --role conductor',
    '<%= config.bin %> agents add kimi --key sk-...',
  ]

  static args = {
    id: Args.string({description: 'Agent id (claude, codex, kimi)', required: true}),
  }

  static flags = {
    role: Flags.string({options: ['conductor', 'implementer'], default: 'implementer'}),
    key: Flags.string({char: 'k', description: 'API key (BYOK mode)'}),
    model: Flags.string({char: 'm', description: 'Model override'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(AgentsAdd)
    const {orch, root} = requireOrch()

    const agentInfo = BUILT_IN_AGENTS.find(a => a.id === args.id)
    if (!agentInfo) {
      this.error(`Unknown agent: ${args.id}. Available: ${BUILT_IN_AGENTS.map(a => a.id).join(', ')}`)
    }

    // Get or prompt for API key
    let apiKey = flags.key
    if (!apiKey && agentInfo.defaultMode === 'byok') {
      const rl = readline.createInterface({input, output})
      try {
        apiKey = await rl.question(`API key for ${agentInfo.displayName}: `)
        apiKey = apiKey.trim()
      } finally {
        rl.close()
      }
    }

    if (apiKey) {
      await storeCredential(args.id, apiKey)
    }

    const peers = orch.readPeers() ?? {conductor: '', peers: []}

    // Check if already added
    if (peers.peers.some(p => p.id === args.id)) {
      this.log(`${agentInfo.displayName} is already in the peer list.`)
      return
    }

    const role = flags.role as 'conductor' | 'implementer'
    const newPeer: PeerConfig = {
      id: args.id,
      displayName: agentInfo.displayName,
      type: agentInfo.defaultMode === 'oauth' ? 'tool' : 'api',
      provider: agentInfo.provider,
      mode: apiKey ? 'byok' : 'oauth',
      contextFile: agentInfo.contextFile,
      branch: `agent/${args.id}`,
      role,
      ...(flags.model ? {model: flags.model} : {}),
    }

    peers.peers.push(newPeer)
    if (role === 'conductor' || !peers.conductor) {
      peers.conductor = args.id
    }

    orch.writePeers(peers)
    this.log(`Added ${agentInfo.displayName} as ${role}`)
  }
}
