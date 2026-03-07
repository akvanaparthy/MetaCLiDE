import {Command, Args, Flags} from '@oclif/core'
import {BUILT_IN_AGENTS, detectInstalledCLIs} from '../../lib/auth/session.js'
import {storeCredential} from '../../lib/auth/keychain.js'
import {requireOrch} from '../../lib/orch/index.js'
import {installPlugin} from '../../lib/plugins/registry.js'
import type {PeerConfig} from '../../types.js'
import * as readline from 'node:readline/promises'
import {stdin as input, stdout as output} from 'node:process'

export default class AgentsAdd extends Command {
  static description = 'Add an agent to the active peer session'

  static examples = [
    '<%= config.bin %> agents add claude',
    '<%= config.bin %> agents add codex --role conductor',
    '<%= config.bin %> agents add kimi --key sk-...',
    '<%= config.bin %> agents add my-llm --provider openai --base-url https://api.groq.com/openai/v1 --key gsk_...',
  ]

  static args = {
    id: Args.string({description: 'Agent id (claude, codex, kimi, or custom)', required: true}),
  }

  static flags = {
    role: Flags.string({options: ['conductor', 'implementer'], default: 'implementer'}),
    key: Flags.string({char: 'k', description: 'API key'}),
    model: Flags.string({char: 'm', description: 'Model override'}),
    provider: Flags.string({description: 'Provider for custom agents (openai, moonshot, or any OpenAI-compat)'}),
    'base-url': Flags.string({description: 'Base URL for custom OpenAI-compatible providers'}),
    'install-cli': Flags.boolean({description: 'Install the agent CLI if not found (Codex: npm i -g @openai/codex, Kimi: pip install kimi-cli)'}),
    plugin: Flags.string({description: 'Path to a plugin manifest.json for custom peer adapters'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(AgentsAdd)
    const {orch} = requireOrch()

    const clis = detectInstalledCLIs()
    const rl = readline.createInterface({input, output})

    try {
      // Plugin path
      if (flags.plugin) {
        await this.addPlugin(args.id, flags, orch)
        return
      }

      // Custom provider path
      if (flags.provider || flags['base-url']) {
        await this.addCustomAgent(args.id, flags, orch, rl)
        return
      }

      const agentInfo = BUILT_IN_AGENTS.find(a => a.id === args.id)
      if (!agentInfo) {
        // Treat as custom with id as provider hint
        this.log(`Unknown built-in agent "${args.id}". Use --provider and --base-url for custom agents.`)
        this.log(`Built-in: ${BUILT_IN_AGENTS.map(a => a.id).join(', ')}`)
        return
      }

      // Show CLI status for tool-backed agents
      if (args.id !== 'claude') {
        const cliFound = clis[args.id] ?? false
        if (cliFound) {
          this.log(`✓ ${agentInfo.displayName} CLI found — will use full agent mode (subprocess)`)
        } else {
          this.log(`⚠ ${agentInfo.displayName} CLI not found — will use API chat mode (agentic loop via API)`)
          this.log(`  To enable full agent mode:`)
          if (args.id === 'codex') this.log(`    npm install -g @openai/codex`)
          if (args.id === 'kimi') this.log(`    pip install kimi-cli`)

          if (flags['install-cli']) {
            await this.installCLI(args.id)
          }
        }
      }

      // Resolve API key
      let apiKey = flags.key
      if (!apiKey && agentInfo.defaultMode === 'byok') {
        apiKey = await rl.question(`API key for ${agentInfo.displayName} (leave blank for OAuth): `)
        apiKey = apiKey.trim() || undefined
      }

      if (apiKey) {
        await storeCredential(args.id, apiKey)
        this.log(`Stored API key for ${agentInfo.displayName}`)
      }

      // Build peer config
      const peers = orch.readPeers() ?? {conductor: '', peers: []}
      if (peers.peers.some(p => p.id === args.id)) {
        this.log(`${agentInfo.displayName} is already in the peer list. Remove it first to re-add.`)
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
      if (role === 'conductor' || !peers.conductor) peers.conductor = args.id
      orch.writePeers(peers)

      this.log(`Added ${agentInfo.displayName} as ${role}`)
      this.log(`Peer count: ${peers.peers.length}`)
      if (peers.peers.length >= 2) {
        this.log(`Ready. Run \`metaclide\` to start.`)
      } else {
        this.log(`Add one more agent to reach the minimum of 2.`)
      }
    } finally {
      rl.close()
    }
  }

  private async addCustomAgent(
    id: string,
    flags: Record<string, unknown>,
    orch: ReturnType<typeof requireOrch>['orch'],
    rl: readline.Interface
  ): Promise<void> {
    const provider = (flags.provider as string) ?? 'openai'
    const baseURL = flags['base-url'] as string | undefined
    const apiKey = flags.key as string | undefined ?? (await rl.question(`API key for ${id}: `)).trim()

    if (apiKey) await storeCredential(id, apiKey)

    const peers = orch.readPeers() ?? {conductor: '', peers: []}
    if (peers.peers.some(p => p.id === id)) {
      this.log(`Agent "${id}" already in peer list.`)
      return
    }

    const role = (flags.role as 'conductor' | 'implementer') ?? 'implementer'
    const newPeer: PeerConfig = {
      id,
      displayName: id,
      type: 'api',
      provider,
      mode: 'byok',
      contextFile: 'AGENTS.md',
      branch: `agent/${id}`,
      role,
      ...(flags.model ? {model: flags.model as string} : {}),
      ...(baseURL ? {baseURL} : {}),
    }

    peers.peers.push(newPeer)
    if (role === 'conductor' || !peers.conductor) peers.conductor = id
    orch.writePeers(peers)

    this.log(`Added custom agent "${id}" (provider: ${provider}${baseURL ? `, base: ${baseURL}` : ''})`)
    this.log(`Mode: agentic API loop (full file editing + bash via tool calling)`)
  }

  private async addPlugin(
    id: string,
    flags: Record<string, unknown>,
    orch: ReturnType<typeof requireOrch>['orch'],
  ): Promise<void> {
    const manifestPath = flags.plugin as string
    try {
      const manifest = installPlugin(manifestPath)
      const role = (flags.role as 'conductor' | 'implementer') ?? 'implementer'
      const peers = orch.readPeers() ?? {conductor: '', peers: []}

      const newPeer: PeerConfig = {
        id: manifest.id,
        displayName: manifest.displayName ?? manifest.id,
        type: 'tool',
        provider: manifest.id,
        mode: 'byok',
        contextFile: 'AGENTS.md',
        branch: `agent/${manifest.id}`,
        role,
      }

      peers.peers.push(newPeer)
      if (role === 'conductor' || !peers.conductor) peers.conductor = manifest.id
      orch.writePeers(peers)

      this.log(`✓ Plugin "${manifest.id}" installed and added as ${role}`)
    } catch (err) {
      this.error(`Plugin install failed: ${err}`)
    }
  }

  private async installCLI(agentId: string): Promise<void> {
    const {execa} = await import('execa')
    this.log(`Installing ${agentId} CLI...`)
    try {
      if (agentId === 'codex') {
        await execa('npm', ['install', '-g', '@openai/codex'], {stdio: 'inherit'})
        this.log(`✓ Codex CLI installed`)
      } else if (agentId === 'kimi') {
        await execa('pip', ['install', 'kimi-cli'], {stdio: 'inherit'})
        this.log(`✓ Kimi CLI installed`)
      }
    } catch (err) {
      this.warn(`CLI install failed: ${err}. Will use API mode instead.`)
    }
  }
}
