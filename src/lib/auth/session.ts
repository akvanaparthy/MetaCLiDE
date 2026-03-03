import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Known session file locations for tool-backed agents
export const SESSION_FILES: Record<string, string> = {
  codex: path.join(os.homedir(), '.codex', 'auth.json'),
  kimi: path.join(os.homedir(), '.kimi', 'credentials', 'kimi-code.json'),
}

export function hasExistingSession(agentId: string): boolean {
  const sessionFile = SESSION_FILES[agentId]
  if (!sessionFile) return false
  return fs.existsSync(sessionFile)
}

export function readSessionFile(agentId: string): Record<string, unknown> | null {
  const sessionFile = SESSION_FILES[agentId]
  if (!sessionFile || !fs.existsSync(sessionFile)) return null
  try {
    return JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  } catch {
    return null
  }
}

export function detectInstalledCLIs(): Record<string, boolean> {
  // Check for CLI tools by looking for executables
  const results: Record<string, boolean> = {}
  const toCheck = [
    {id: 'claude', bins: ['claude']},
    {id: 'codex', bins: ['codex']},
    {id: 'kimi', bins: ['kimi', 'kimi-code']},
  ]
  const pathEnv = process.env.PATH ?? ''
  const dirs = pathEnv.split(path.delimiter)

  for (const {id, bins} of toCheck) {
    results[id] = bins.some(bin =>
      dirs.some(dir => {
        const full = path.join(dir, bin)
        const fullExe = path.join(dir, bin + '.exe')
        return fs.existsSync(full) || fs.existsSync(fullExe)
      })
    )
  }
  return results
}

export interface AgentInfo {
  id: string
  displayName: string
  provider: string
  defaultMode: 'oauth' | 'byok'
  contextFile: string
  hasSession: boolean
  cliInstalled: boolean
  description: string
}

export const BUILT_IN_AGENTS: AgentInfo[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    provider: 'anthropic',
    defaultMode: 'byok',
    contextFile: 'CLAUDE.md',
    hasSession: false,
    cliInstalled: false,
    description: 'Anthropic\'s Claude Code agent (API-backed via ANTHROPIC_API_KEY)',
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    provider: 'openai',
    defaultMode: 'oauth',
    contextFile: 'AGENTS.md',
    hasSession: false,
    cliInstalled: false,
    description: 'OpenAI Codex CLI agent (OAuth or BYOK via OPENAI_API_KEY)',
  },
  {
    id: 'kimi',
    displayName: 'Kimi Code',
    provider: 'moonshot',
    defaultMode: 'oauth',
    contextFile: 'AGENTS.md',
    hasSession: false,
    cliInstalled: false,
    description: 'Moonshot AI Kimi Code agent (OAuth or BYOK via MOONSHOT_API_KEY)',
  },
]

export function getAgentsWithStatus(): AgentInfo[] {
  const sessions: Record<string, boolean> = {}
  for (const id of Object.keys(SESSION_FILES)) {
    sessions[id] = hasExistingSession(id)
  }
  const clis = detectInstalledCLIs()

  return BUILT_IN_AGENTS.map(agent => ({
    ...agent,
    hasSession: sessions[agent.id] ?? false,
    cliInstalled: clis[agent.id] ?? false,
  }))
}
