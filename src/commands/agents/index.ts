import {Command} from '@oclif/core'
import {getAgentsWithStatus} from '../../lib/auth/session.js'
import {listStoredAgents} from '../../lib/auth/keychain.js'
import {findRepoRoot, OrchManager} from '../../lib/orch/index.js'

export default class Agents extends Command {
  static description = 'List available and connected AI coding agents'

  static examples = [
    '<%= config.bin %> agents',
  ]

  async run(): Promise<void> {
    const agents = getAgentsWithStatus()
    const stored = await listStoredAgents()

    // Check if there's an active session with peers configured
    const repoRoot = findRepoRoot()
    let activePeers: string[] = []
    if (repoRoot) {
      const orch = new OrchManager(repoRoot)
      if (orch.exists()) {
        const peers = orch.readPeers()
        if (peers) activePeers = peers.peers.map(p => p.id)
      }
    }

    this.log('Built-in agents:')
    this.log('')

    for (const agent of agents) {
      const hasKey = stored.includes(agent.id)
      const connected = hasKey || agent.hasSession
      const active = activePeers.includes(agent.id)
      const tag = active ? ' [ACTIVE]' : connected ? ' [connected]' : ''

      this.log(`  ${agent.displayName} (${agent.id})${tag}`)
      this.log(`    Provider: ${agent.provider}`)
      this.log(`    Auth: ${hasKey ? 'BYOK key stored' : agent.hasSession ? 'OAuth session' : 'not connected'}`)
      this.log(`    CLI: ${agent.cliInstalled ? 'installed' : 'not found'}`)
      this.log(`    ${agent.description}`)
      this.log('')
    }

    this.log('Subcommands: metaclide agents add | metaclide agents remove <id>')
  }
}
