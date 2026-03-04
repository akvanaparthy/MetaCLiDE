import {Command, Flags} from '@oclif/core'
import {requireOrch} from '../lib/orch/index.js'
import {getCredential} from '../lib/auth/keychain.js'
import {OrchestrationRunner} from '../lib/orch/runner.js'

export default class Run extends Command {
  static description = 'Start a multi-agent coding session'

  static examples = [
    '<%= config.bin %> run',
    '<%= config.bin %> run --agents claude,codex',
    '<%= config.bin %> run --non-interactive --agents claude,kimi --budget anthropic=3,moonshot=2',
  ]

  static flags = {
    agents: Flags.string({char: 'a', description: 'Comma-separated agent ids (default: all configured)'}),
    budget: Flags.string({char: 'b', description: 'Budget limits e.g. anthropic=3,openai=5 (USD)'}),
    'non-interactive': Flags.boolean({default: false}),
    stack: Flags.string({description: 'Tech stack hint e.g. "nextjs,prisma,postgres"'}),
    'skip-planning': Flags.boolean({description: 'Skip planning if contracts already exist'}),
    'skip-review': Flags.boolean({description: 'Skip contract review (auto-ACK)'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Run)
    const {orch, root} = requireOrch()

    const peersFile = orch.readPeers()
    if (!peersFile || peersFile.peers.length < 2) {
      this.error('Need at least 2 peers. Run `metaclide agents add` to add agents.')
    }

    let selectedPeers = peersFile.peers
    if (flags.agents) {
      const ids = flags.agents.split(',').map(s => s.trim())
      selectedPeers = peersFile.peers.filter(p => ids.includes(p.id))
      if (selectedPeers.length < 2) {
        this.error(`Need at least 2 peers. Got: ${selectedPeers.map(p => p.id).join(', ')}`)
      }
    }

    // Resolve API keys
    for (const peer of selectedPeers) {
      if (peer.mode === 'byok' && !peer.apiKey) {
        const key = await getCredential(peer.id)
        if (key) peer.apiKey = key
      }
    }

    const conductorId = peersFile.conductor || selectedPeers[0].id

    this.log(`MetaCLiDE — starting session`)
    this.log(`Conductor: ${selectedPeers.find(p => p.id === conductorId)?.displayName ?? conductorId}`)
    this.log(`Peers: ${selectedPeers.map(p => p.displayName).join(', ')}`)
    this.log('')

    const runner = new OrchestrationRunner()

    for await (const event of runner.run({
      repoRoot: root,
      selectedPeers,
      conductorId,
      skipPlanning: flags['skip-planning'],
      skipReview: flags['skip-review'],
      stack: flags.stack,
    })) {
      switch (event.type) {
        case 'phase':
          this.log(`\n${'='.repeat(50)}`)
          this.log(`  ${event.message}`)
          this.log('='.repeat(50))
          break
        case 'log':
          if (event.level === 'warn') this.warn(event.message)
          else if (event.level === 'error') this.error(event.message, {exit: false})
          else this.log(event.message)
          break
        case 'peer_event': {
          const e = event.peerEvent
          if (e.type === 'text' && e.content) {
            process.stdout.write(`[${event.peerId}] ${e.content.slice(0, 120).replace(/\n/g, ' ')}\n`)
          } else if (e.type === 'tool_use') {
            this.log(`[${event.peerId}] ⚙ ${e.toolName}`)
          } else if (e.type === 'result') {
            this.log(`[${event.peerId}] ✓ done${e.costUsd ? ` ($${e.costUsd.toFixed(4)})` : ''}`)
          } else if (e.type === 'error') {
            this.warn(`[${event.peerId}] ✗ ${e.error}`)
          }
          break
        }
        case 'peer_phase':
          this.log(`[${event.peerId}] ${event.status}`)
          break
        case 'contract_locked':
          this.log(`✓ Contracts locked v${event.version} (${event.hash.slice(0, 8)})`)
          break
        case 'gate_result': {
          const icon = event.result === 'pass' ? '✓' : event.result === 'skip' ? '−' : '✗'
          this.log(`  ${icon} ${event.gate}: ${event.result}`)
          if (event.result === 'fail' && event.output) {
            this.log(event.output.split('\n').slice(0, 10).map(l => `    ${l}`).join('\n'))
          }
          break
        }
        case 'fix_iteration':
          this.log(`\nFix iteration ${event.n}/${event.max}`)
          break
        case 'cr_detected':
          this.warn(`\nCR filed by ${event.cr.from}: ${event.cr.what}`)
          break
        case 'complete':
          this.log('\n✓ Session complete. See .orch/integration-report.md')
          break
        case 'error':
          this.error(event.message, {exit: false})
          break
      }
    }
  }
}
