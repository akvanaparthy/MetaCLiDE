import {Command, Flags} from '@oclif/core'
import {requireOrch} from '../lib/orch/index.js'
import {ContractLock} from '../lib/contracts/lock.js'

export default class Status extends Command {
  static description = 'Show current session phase, peer statuses, and task progress'

  static examples = ['<%= config.bin %> status']

  static flags = {
    json: Flags.boolean({description: 'Output as JSON'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Status)
    const {orch, root} = requireOrch()

    const peers = orch.readPeers()
    const plan = orch.readPlan()
    const statuses = orch.allPeerStatuses()
    const crs = orch.listChangeRequests()
    const contractLock = new ContractLock(root)
    const lock = contractLock.readLock()
    const contractVersion = orch.readContractVersion()

    if (flags.json) {
      this.log(JSON.stringify({peers, plan, statuses, crs, lock, contractVersion}, null, 2))
      return
    }

    this.log('=== MetaCLiDE Status ===')
    this.log('')

    // Contract status
    this.log(`Contracts: v${contractVersion} ${lock ? `[LOCKED by ${lock.lockedBy}]` : '[unlocked]'}`)
    this.log('')

    // Peer statuses
    if (!peers) {
      this.log('No peers configured.')
    } else {
      this.log(`Conductor: ${peers.conductor}`)
      this.log('')
      this.log('Peers:')
      for (const peer of peers.peers) {
        const status = statuses.find(s => s.peer === peer.id)
        this.log(`  ${peer.displayName} (${peer.id}) — ${peer.role}`)
        if (status) {
          this.log(`    Contract ACK: v${status.contractVersion}`)
          this.log(`    Active tasks: ${status.activeTasks.join(', ') || 'none'}`)
          this.log(`    Blocked: ${status.blockedBy ?? 'no'}`)
          this.log(`    Last commit: ${status.lastCommit || 'none'}`)
          if (Object.keys(status.lastGateResult).length > 0) {
            const gates = Object.entries(status.lastGateResult).map(([k, v]) => `${k}:${v}`).join(' ')
            this.log(`    Gates: ${gates}`)
          }
          if (status.notes) this.log(`    Notes: ${status.notes}`)
        } else {
          this.log(`    No status recorded yet`)
        }
        this.log('')
      }
    }

    // Task progress
    if (plan) {
      const total = plan.tasks.length
      const done = plan.tasks.filter(t => t.status === 'done').length
      const inProgress = plan.tasks.filter(t => t.status === 'in-progress').length
      const blocked = plan.tasks.filter(t => t.status === 'blocked').length

      this.log(`Tasks: ${done}/${total} done, ${inProgress} in-progress, ${blocked} blocked`)
      this.log('')
      for (const task of plan.tasks) {
        const icon = {done: '✓', 'in-progress': '→', blocked: '✗', pending: '○', failed: '✗'}[task.status] ?? '?'
        this.log(`  ${icon} [${task.id}] ${task.title} (owner: ${task.owner})`)
      }
      this.log('')
    }

    // Change requests
    if (crs.length > 0) {
      this.log(`Change Requests (${crs.length}):`)
      for (const cr of crs) {
        this.log(`  ${cr.id} [${cr.status}] from ${cr.from}: ${cr.what}`)
      }
      this.log('')
    }
  }
}
