import {Command, Flags} from '@oclif/core'
import {storeCredential, listStoredAgents} from '../lib/auth/keychain.js'
import {getAgentsWithStatus, BUILT_IN_AGENTS} from '../lib/auth/session.js'
import * as readline from 'node:readline/promises'
import {stdin as input, stdout as output} from 'node:process'

export default class Connect extends Command {
  static description = 'Connect and authenticate AI coding agents'

  static examples = [
    '<%= config.bin %> connect',
    '<%= config.bin %> connect --agent claude --key sk-ant-...',
    '<%= config.bin %> connect --list',
  ]

  static flags = {
    agent: Flags.string({char: 'a', description: 'Agent id to connect (claude, codex, kimi)'}),
    key: Flags.string({char: 'k', description: 'API key (for BYOK mode)'}),
    list: Flags.boolean({char: 'l', description: 'List connected agents'}),
    remove: Flags.string({description: 'Remove a connected agent credential'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Connect)

    if (flags.list) {
      await this.listAgents()
      return
    }

    if (flags.remove) {
      const {deleteCredential} = await import('../lib/auth/keychain.js')
      await deleteCredential(flags.remove)
      this.log(`Removed credential for: ${flags.remove}`)
      return
    }

    if (flags.agent) {
      await this.connectAgent(flags.agent, flags.key)
    } else {
      // Interactive mode
      await this.interactiveConnect()
    }
  }

  private async listAgents(): Promise<void> {
    const stored = await listStoredAgents()
    const agentStatus = getAgentsWithStatus()

    this.log('Connected agents:')
    this.log('')

    for (const agent of agentStatus) {
      const hasKey = stored.includes(agent.id)
      const authMode = hasKey ? 'BYOK (API key stored)' : agent.hasSession ? 'OAuth (session found)' : 'Not connected'
      const status = hasKey || agent.hasSession ? '✓' : '✗'
      this.log(`  ${status} ${agent.displayName} (${agent.id})`)
      this.log(`    Auth: ${authMode}`)
      this.log(`    CLI installed: ${agent.cliInstalled ? 'yes' : 'no'}`)
      this.log('')
    }

    const totalConnected = stored.length + agentStatus.filter(a => a.hasSession && !stored.includes(a.id)).length
    this.log(`Total connected: ${totalConnected}`)
  }

  private async connectAgent(agentId: string, apiKey?: string): Promise<void> {
    const agent = BUILT_IN_AGENTS.find(a => a.id === agentId)
    if (!agent) {
      this.error(`Unknown agent: ${agentId}. Use 'metaclide agents' to see available agents.`)
    }

    if (apiKey) {
      await storeCredential(agentId, apiKey)
      this.log(`Stored API key for ${agent.displayName}`)
      return
    }

    // Check for existing session
    const {hasExistingSession} = await import('../lib/auth/session.js')
    if (hasExistingSession(agentId)) {
      this.log(`Found existing OAuth session for ${agent.displayName}`)
      return
    }

    // Prompt for API key
    const rl = readline.createInterface({input, output})
    try {
      const key = await rl.question(`Enter API key for ${agent.displayName}: `)
      if (key.trim()) {
        await storeCredential(agentId, key.trim())
        this.log(`Stored API key for ${agent.displayName}`)
      } else {
        this.log('No key entered. Skipped.')
      }
    } finally {
      rl.close()
    }
  }

  private async interactiveConnect(): Promise<void> {
    const agents = getAgentsWithStatus()
    const stored = await listStoredAgents()

    this.log('Available agents:')
    this.log('')
    agents.forEach((a, i) => {
      const connected = stored.includes(a.id) || a.hasSession
      this.log(`  ${i + 1}. ${a.displayName} (${a.id}) — ${connected ? 'connected' : 'not connected'}`)
      this.log(`     ${a.description}`)
    })
    this.log('')

    const rl = readline.createInterface({input, output})
    try {
      for (const agent of agents) {
        const alreadyConnected = stored.includes(agent.id) || agent.hasSession
        if (alreadyConnected) {
          this.log(`${agent.displayName}: already connected, skipping`)
          continue
        }

        const answer = await rl.question(`Connect ${agent.displayName}? [y/N] `)
        if (answer.toLowerCase() !== 'y') continue

        if (agent.hasSession) {
          this.log(`Using existing OAuth session for ${agent.displayName}`)
        } else {
          const key = await rl.question(`  Enter API key for ${agent.displayName}: `)
          if (key.trim()) {
            await storeCredential(agent.id, key.trim())
            this.log(`  Stored key for ${agent.displayName}`)
          }
        }
      }
    } finally {
      rl.close()
    }

    this.log('')
    this.log('Done. Run `metaclide run` to start a session.')
  }
}
