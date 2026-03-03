import {Command, Flags} from '@oclif/core'
import {requireOrch} from '../lib/orch/index.js'
import {ContractLock} from '../lib/contracts/lock.js'
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
      description: 'Resume from a specific phase',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Resume)
    const {orch, root} = requireOrch()

    const peers = orch.readPeers()
    if (!peers) {
      this.error('No session found. Run `metaclide run` to start a new session.')
    }

    const statuses = orch.allPeerStatuses()
    const crs = orch.listChangeRequests().filter(cr => cr.status === 'pending')
    const contractLock = new ContractLock(root)
    const lock = contractLock.readLock()

    this.log('=== Resuming MetaCLiDE Session ===')
    this.log('')

    // Detect state
    if (crs.length > 0) {
      this.log(`${crs.length} pending Change Request(s) detected:`)
      for (const cr of crs) {
        this.log(`  ${cr.id}: ${cr.what}`)
        this.log(`    From: ${cr.from}`)
        this.log(`    Why: ${cr.why}`)
        this.log(`    Impact: ${cr.impact.join(', ')}`)
      }
      this.log('')
      this.log('The session is in Consensus Pause. Resolve CRs before resuming.')
      this.log('The Conductor must review and update each CR with a resolution.')
      return
    }

    // Check gate results
    const failedPeers = statuses.filter(s =>
      Object.values(s.lastGateResult).some(v => v === 'fail')
    )

    if (failedPeers.length > 0) {
      this.log('Peers with gate failures:')
      for (const s of failedPeers) {
        const failed = Object.entries(s.lastGateResult)
          .filter(([, v]) => v === 'fail')
          .map(([k]) => k)
        this.log(`  ${s.peer}: ${failed.join(', ')} failed`)
      }
      this.log('')
    }

    const phase = flags.from ?? this.detectPhase(statuses, lock)
    this.log(`Resuming from phase: ${phase}`)
    this.log('')
    this.log('Run `metaclide run --skip-planning` to continue implementation.')
    this.log('Or run `metaclide run --skip-planning --skip-review` to jump to implementation.')
  }

  private detectPhase(
    statuses: PeerStatus[],
    lock: {lockedBy: string; version: number; hash: string; lockedAt: string} | null
  ): string {
    if (!lock) return 'planning'
    const allAcked = statuses.every(s => s.contractVersion > 0)
    if (!allAcked) return 'review'
    const anyInProgress = statuses.some(s => s.activeTasks.length > 0)
    if (anyInProgress) return 'implement'
    return 'integrate'
  }
}
