import {Command} from '@oclif/core'
import {execa} from 'execa'
import fs from 'node:fs'
import path from 'node:path'
import {findRepoRoot} from '../lib/orch/index.js'
import {isKeytarAvailable} from '../lib/auth/keychain.js'
import {detectInstalledCLIs} from '../lib/auth/session.js'

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

    // Agent CLIs
    const clis = detectInstalledCLIs()
    const cliChecks: Array<{id: string; name: string}> = [
      {id: 'claude', name: 'claude (Claude Code CLI)'},
      {id: 'codex', name: 'codex (Codex CLI)'},
      {id: 'kimi', name: 'kimi (Kimi Code CLI)'},
    ]
    for (const {id, name} of cliChecks) {
      checks.push({
        name,
        status: clis[id] ? 'ok' : 'warn',
        message: clis[id] ? 'Found' : 'Not found (optional — can use BYOK API instead)',
      })
    }

    // Environment variables
    const envVars: Array<{key: string; required: boolean}> = [
      {key: 'ANTHROPIC_API_KEY', required: false},
      {key: 'OPENAI_API_KEY', required: false},
      {key: 'MOONSHOT_API_KEY', required: false},
    ]
    for (const {key, required} of envVars) {
      const present = Boolean(process.env[key])
      checks.push({
        name: key,
        status: present ? 'ok' : required ? 'fail' : 'warn',
        message: present ? 'Set' : 'Not set (optional — can store via metaclide connect)',
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
