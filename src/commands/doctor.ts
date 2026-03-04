import {Command} from '@oclif/core'
import {execa} from 'execa'
import fs from 'node:fs'
import path from 'node:path'
import {findRepoRoot} from '../lib/orch/index.js'
import {isKeytarAvailable} from '../lib/auth/keychain.js'
import {detectInstalledCLIs} from '../lib/auth/session.js'
import {hasCodexOAuthSession, getCodexApiKey} from '../lib/auth/oauth-codex.js'
import {hasKimiSession} from '../lib/auth/oauth-kimi.js'

interface CheckResult {
  name: string
  status: 'ok' | 'warn' | 'fail'
  message: string
}

export default class Doctor extends Command {
  static description = 'Validate MetaCLiDE dependencies and environment'

  static examples = ['<%= config.bin %> doctor']

  async run(): Promise<void> {
    this.log('=== MetaCLiDE Doctor ===')
    this.log('')

    const checks: CheckResult[] = []

    // Node.js version
    const nodeVersion = process.version
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10)
    checks.push({
      name: 'Node.js >= 20',
      status: nodeMajor >= 20 ? 'ok' : 'fail',
      message: `Found ${nodeVersion}`,
    })

    // Git
    try {
      const {stdout} = await execa('git', ['--version'])
      checks.push({name: 'git', status: 'ok', message: stdout.trim()})
    } catch {
      checks.push({name: 'git', status: 'fail', message: 'Not found. Install git.'})
    }

    // Git repo
    const repoRoot = findRepoRoot()
    checks.push({
      name: 'Git repository',
      status: repoRoot ? 'ok' : 'warn',
      message: repoRoot ? repoRoot : 'Not in a git repo. Run git init.',
    })

    // .orch directory
    if (repoRoot) {
      const orchExists = fs.existsSync(path.join(repoRoot, '.orch'))
      checks.push({
        name: '.orch directory',
        status: orchExists ? 'ok' : 'warn',
        message: orchExists ? 'Initialized' : 'Not initialized. Run metaclide init.',
      })
    }

    // OS Keychain (keytar)
    const keytarOk = await isKeytarAvailable()
    checks.push({
      name: 'OS Keychain (keytar)',
      status: keytarOk ? 'ok' : 'warn',
      message: keytarOk ? 'Available' : 'Not available — using fallback file storage (~/.metaclide/credentials.json)',
    })

    // Agent CLIs + auth status
    const clis = detectInstalledCLIs()

    // Claude
    const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY)
    checks.push({
      name: 'Claude Code',
      status: hasAnthropicKey ? 'ok' : 'warn',
      message: hasAnthropicKey
        ? `API key set (BYOK) — full agent via @anthropic-ai/claude-agent-sdk`
        : 'No API key — set ANTHROPIC_API_KEY or run: metaclide connect --agent claude',
    })

    // Codex
    const codexSub = hasCodexOAuthSession()
    const codexKey = getCodexApiKey()
    const codexCliInstalled = clis['codex'] ?? false
    checks.push({
      name: 'Codex CLI',
      status: codexCliInstalled ? 'ok' : 'warn',
      message: codexCliInstalled
        ? `Installed — ${codexSub ? '✓ subscription (ChatGPT)' : codexKey ? '✓ API key' : 'not authenticated — run: metaclide connect --agent codex --oauth'}`
        : 'Not installed — agents will use agentic API loop (install: npm i -g @openai/codex for CLI mode)',
    })

    // Kimi
    const kimiSub = hasKimiSession()
    const kimiKey = Boolean(process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY)
    const kimiCliInstalled = clis['kimi'] ?? false
    checks.push({
      name: 'Kimi Code CLI',
      status: kimiCliInstalled ? 'ok' : 'warn',
      message: kimiCliInstalled
        ? `Installed — ${kimiSub ? '✓ subscription (Kimi Code)' : kimiKey ? '✓ API key' : 'not authenticated — run: metaclide connect --agent kimi --oauth'}`
        : 'Not installed — agents will use agentic API loop (install: pip install kimi-cli for CLI mode)',
    })

    // Environment variables
    const envVars: Array<{key: string; note: string}> = [
      {key: 'ANTHROPIC_API_KEY', note: 'Claude (required for Claude peer)'},
      {key: 'OPENAI_API_KEY', note: 'Codex BYOK fallback'},
      {key: 'KIMI_API_KEY', note: 'Kimi Code BYOK (preferred over MOONSHOT_API_KEY)'},
      {key: 'MOONSHOT_API_KEY', note: 'Kimi/Moonshot API (fallback)'},
    ]
    for (const {key, note} of envVars) {
      const present = Boolean(process.env[key])
      checks.push({
        name: key,
        status: present ? 'ok' : 'warn',
        message: present ? `Set (${note})` : `Not set — ${note}`,
      })
    }

    // gh CLI (for PR export)
    try {
      const {stdout} = await execa('gh', ['--version'])
      checks.push({name: 'gh (GitHub CLI)', status: 'ok', message: stdout.split('\n')[0].trim()})
    } catch {
      checks.push({name: 'gh (GitHub CLI)', status: 'warn', message: 'Not found (optional — needed for --pr export)'})
    }

    // Print results
    let hasFailure = false
    for (const check of checks) {
      const icon = check.status === 'ok' ? '✓' : check.status === 'warn' ? '⚠' : '✗'
      this.log(`  ${icon} ${check.name}: ${check.message}`)
      if (check.status === 'fail') hasFailure = true
    }

    this.log('')
    if (hasFailure) {
      this.log('Some checks failed. Fix the issues above before running MetaCLiDE.')
    } else {
      this.log('All critical checks passed. MetaCLiDE is ready to use.')
    }
  }
}
