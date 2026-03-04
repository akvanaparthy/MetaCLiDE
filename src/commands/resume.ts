import {Command, Flags} from '@oclif/core'
import {requireOrch} from '../lib/orch/index.js'
import {ContractLock} from '../lib/contracts/lock.js'
import {getCredential} from '../lib/auth/keychain.js'
import {OrchestrationRunner} from '../lib/orch/runner.js'
import type {PeerStatus} from '../types.js'

export default class Resume extends Command {
  static description = 'Resume a paused or failed MetaCLiDE session'

  static examples = [
    '<%= config.bin %> resume',
    '<%= config.bin %> resume --from implement',
  ]

  static flags = {
    from: Flags.string({
      options: ['planning', 'review', 'implement', 'integrate'],
      description: 'Override phase detection and resume from this phase',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Resume)
    const {orch, root} = requireOrch()

    const peers = orch.readPeers()
    if (!peers || peers.peers.length < 2) {
      this.error('No session found. Run `metaclide run` to start.')
    }

    const statuses = orch.allPeerStatuses()
    const pendingCRs = orch.listChangeRequests().filter(cr => cr.status === 'pending')
    const lock = new ContractLock(root).readLock()

    // ── Show current state ──
    this.log('=== MetaCLiDE Resume ===')
    this.log('')

    if (pendingCRs.length > 0) {
      this.warn(`${pendingCRs.length} unresolved Change Request(s):`)
      for (const cr of pendingCRs) {
        this.log(`  ${cr.id} [${cr.from}]: ${cr.what}`)
        this.log(`    Why: ${cr.why}`)
      }
      this.log('\nResolve CRs before resuming. The Conductor must accept/reject each one.')
      this.log('Run `metaclide status --json` to inspect the full state.')
      return
    }

    const phase = flags.from ?? this.detectPhase(statuses, lock)
    this.log(`Detected resume point: ${phase}`)
    this.log('')

    const skipPlanning = phase !== 'planning'
    const skipReview = phase === 'implement' || phase === 'integrate'

    // Resolve API keys
    const selectedPeers = peers.peers
    for (const peer of selectedPeers) {
      if (peer.mode === 'byok' && !peer.apiKey) {
        const key = await getCredential(peer.id)
        if (key) peer.apiKey = key
      }
    }

    this.log(`Resuming from: ${phase}`)
    this.log(`Conductor: ${peers.conductor}`)
    this.log(`Peers: ${selectedPeers.map(p => p.displayName).join(', ')}`)
    this.log('')

    const runner = new OrchestrationRunner()

    for await (const event of runner.run({
      repoRoot: root,
      selectedPeers,
      conductorId: peers.conductor,
      skipPlanning,
      skipReview,
    })) {
      switch (event.type) {
        case 'phase':
          this.log(`\n=== ${event.message} ===`)
          break
        case 'log':
          if (event.level === 'warn') this.warn(event.message)
          else this.log(event.message)
          break
        case 'peer_event': {
          const e = event.peerEvent
          if (e.type === 'text' && e.content) process.stdout.write(`[${event.peerId}] ${e.content.slice(0, 100)}\n`)
          else if (e.type === 'result') this.log(`[${event.peerId}] ✓ done`)
          else if (e.type === 'error') this.warn(`[${event.peerId}] ✗ ${e.error}`)
          break
        }
        case 'gate_result':
          this.log(`  ${event.result === 'pass' ? '✓' : '✗'} ${event.gate}: ${event.result}`)
          break
        case 'complete':
          this.log('\n✓ Session resumed and complete.')
          break
        case 'error':
          this.error(event.message, {exit: false})
          break
        default:
          break
      }
    }
  }

  private detectPhase(
    statuses: PeerStatus[],
    lock: {lockedBy: string; version: number} | null
  ): 'planning' | 'review' | 'implement' | 'integrate' {
    if (!lock) return 'planning'
    const allAcked = statuses.length > 0 && statuses.every(s => s.contractVersion > 0)
    if (!allAcked) return 'review'
    const anyActive = statuses.some(s => s.activeTasks.length > 0)
    if (anyActive) return 'implement'
    return 'integrate'
  }
}
