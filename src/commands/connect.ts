import {Command, Flags} from '@oclif/core'
import {storeCredential, listStoredAgents, deleteCredential} from '../lib/auth/keychain.js'
import {getAgentsWithStatus, BUILT_IN_AGENTS} from '../lib/auth/session.js'
import {getCodexApiKey, hasCodexOAuthSession, loginCodexBrowser, loginCodexDevice} from '../lib/auth/oauth-codex.js'
import {getKimiAccessToken, loginKimiDevice} from '../lib/auth/oauth-kimi.js'
import * as readline from 'node:readline/promises'
import {stdin as input, stdout as output} from 'node:process'

export default class Connect extends Command {
  static description = 'Connect and authenticate AI coding agents'

  static examples = [
    '<%= config.bin %> connect',
    '<%= config.bin %> connect --agent claude --key sk-ant-...',
    '<%= config.bin %> connect --agent codex --oauth',
    '<%= config.bin %> connect --list',
  ]

  static flags = {
    agent: Flags.string({char: 'a', description: 'Agent id (claude, codex, kimi)'}),
    key: Flags.string({char: 'k', description: 'API key (BYOK mode)'}),
    oauth: Flags.boolean({description: 'Use OAuth login flow'}),
    list: Flags.boolean({char: 'l', description: 'List connected agents'}),
    remove: Flags.string({description: 'Remove a stored credential'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Connect)

    if (flags.list) {
      await this.listAgents()
      return
    }

    if (flags.remove) {
      await deleteCredential(flags.remove)
      this.log(`Removed credential for: ${flags.remove}`)
      return
    }

    if (flags.agent) {
      await this.connectAgent(flags.agent, flags.key, flags.oauth)
    } else {
      await this.interactiveConnect()
    }
  }

  private async listAgents(): Promise<void> {
    const stored = await listStoredAgents()
    const agentStatus = getAgentsWithStatus()

    this.log('Connected agents:\n')
    for (const agent of agentStatus) {
      const hasKey = stored.includes(agent.id)
      const authMode = hasKey
        ? 'BYOK key stored'
        : agent.hasSession
          ? 'OAuth session found'
          : 'Not connected'
      const icon = (hasKey || agent.hasSession) ? '✓' : '✗'
      this.log(`  ${icon} ${agent.displayName} (${agent.id})`)
      this.log(`    Auth: ${authMode}`)
      this.log(`    CLI: ${agent.cliInstalled ? 'installed' : 'not found'}`)
      this.log('')
    }
  }

  private async connectAgent(agentId: string, apiKey?: string, oauth?: boolean): Promise<void> {
    const agent = BUILT_IN_AGENTS.find(a => a.id === agentId)
    if (!agent) {
      this.error(`Unknown agent: ${agentId}. Available: ${BUILT_IN_AGENTS.map(a => a.id).join(', ')}`)
    }

    // API key provided directly
    if (apiKey) {
      await storeCredential(agentId, apiKey)
      this.log(`Stored API key for ${agent.displayName}`)
      return
    }

    // OAuth flow
    if (oauth || agent.defaultMode === 'oauth') {
      if (agentId === 'claude') {
        this.error('Claude uses API key authentication only (Anthropic ToS). Use --key flag.')
      }

      if (agentId === 'codex') {
        if (hasCodexOAuthSession()) {
          this.log(`Codex already connected (subscription session found)`)
          return
        }
        const getCodexApiKey_ = getCodexApiKey()
        if (getCodexApiKey_) {
          this.log(`Codex already connected (API key mode)`)
          return
        }
        // Default to subscription mode — uses ChatGPT Plus/Pro/Team credits
        this.log('Starting Codex OAuth login (subscription mode — uses your ChatGPT plan)...')
        this.log('To use API billing instead, use: metaclide connect --agent codex --key <openai-api-key>')
        try {
          await loginCodexBrowser(e => this.log(`  ${e.message}`), {mode: 'subscription'})
          this.log(`✓ Codex connected (subscription)`)
        } catch {
          this.log('Browser flow unavailable, trying device code...')
          await loginCodexDevice(e => this.log(`  ${e.message}`), {mode: 'subscription'})
          this.log(`✓ Codex connected (subscription, device code)`)
        }
        return
      }

      if (agentId === 'kimi') {
        const existing = getKimiAccessToken()
        if (existing) {
          this.log(`Kimi already connected (OAuth session found)`)
          return
        }
        this.log('Starting Kimi OAuth login...')
        const token = await loginKimiDevice(e => this.log(`  ${e.message}`))
        this.log(`✓ Kimi connected (device code)`)
        await storeCredential('kimi', token)
        return
      }
    }

    // Interactive BYOK prompt
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
    const rl = readline.createInterface({input, output})

    this.log('MetaCLiDE — Connect Agents\n')
    agents.forEach((a, i) => {
      const connected = stored.includes(a.id) || a.hasSession
      this.log(`  ${i + 1}. ${a.displayName} (${a.id}) — ${connected ? '✓ connected' : '✗ not connected'}`)
      this.log(`     ${a.description}`)
    })
    this.log('')

    try {
      for (const agent of agents) {
        const connected = stored.includes(agent.id) || agent.hasSession
        if (connected) {
          this.log(`${agent.displayName}: already connected`)
          continue
        }

        const answer = await rl.question(`Connect ${agent.displayName}? [y/N] `)
        if (answer.toLowerCase() !== 'y') continue

        if (agent.id === 'claude') {
          const key = await rl.question(`  ANTHROPIC_API_KEY: `)
          if (key.trim()) {
            await storeCredential('claude', key.trim())
            this.log(`  ✓ Claude connected`)
          }
        } else if (agent.id === 'codex') {
          const method = await rl.question(`  Use [1] OAuth (browser) or [2] API key? `)
          if (method.trim() === '1') {
            rl.close()
            await this.connectAgent('codex', undefined, true)
            return
          } else {
            const key = await rl.question(`  OPENAI_API_KEY: `)
            if (key.trim()) {
              await storeCredential('codex', key.trim())
              this.log(`  ✓ Codex connected`)
            }
          }
        } else if (agent.id === 'kimi') {
          const method = await rl.question(`  Use [1] OAuth (device code) or [2] API key? `)
          if (method.trim() === '1') {
            rl.close()
            await this.connectAgent('kimi', undefined, true)
            return
          } else {
            const key = await rl.question(`  MOONSHOT_API_KEY: `)
            if (key.trim()) {
              await storeCredential('kimi', key.trim())
              this.log(`  ✓ Kimi connected`)
            }
          }
        }
      }
    } finally {
      try { rl.close() } catch { /* already closed */ }
    }

    this.log('\nDone. Run `metaclide` to start.')
  }
}
