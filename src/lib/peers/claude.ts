// Claude peer adapter
// Primary: @anthropic-ai/claude-agent-sdk  query()
// Fallback: claude -p subprocess (--output-format stream-json)
import type {Capability, PeerMessage, PeerEvent, PeerStatusUpdate, PeerConfig} from '../../types.js'
import type {Peer} from './interface.js'
import {PeerLogger} from '../logger/index.js'
import {OrchManager} from '../orch/index.js'
import {SessionStore} from '../orch/sessions.js'

// Bash commands that agents must not execute (deploy / destructive ops)
const BLOCKED_BASH = /git\s+push|rm\s+-rf|npm\s+publish|curl.+deploy|npx.+deploy|vercel\s+deploy|heroku/

export class ClaudePeer implements Peer {
  readonly mode = 'api' as const
  readonly role: 'conductor' | 'implementer'

  private logger: PeerLogger
  private orch: OrchManager
  private sessions: SessionStore

  constructor(
    private readonly config: PeerConfig,
    private readonly repoRoot: string,
    private readonly worktreePath: string
  ) {
    this.role = config.role
    this.logger = new PeerLogger(repoRoot, config.id)
    this.orch = new OrchManager(repoRoot)
    this.sessions = new SessionStore(repoRoot)
  }

  get id(): string { return this.config.id }

  capabilities(): Capability[] {
    return ['read', 'write', 'bash', 'search', 'test']
  }

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const apiKey = (this.config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim()
    if (!apiKey) {
      yield {type: 'error', error: 'ANTHROPIC_API_KEY not set for Claude peer'}
      return
    }

    this.logger.append({type: 'system', content: `send:${msg.type}`, taskId: msg.taskId})

    // Try SDK first
    try {
      yield* this.sendViaSDK(msg, apiKey)
    } catch (importErr) {
      // SDK not installed — fall back to CLI subprocess
      yield* this.sendViaCLI(msg, apiKey)
    }
  }

  private async *sendViaSDK(msg: PeerMessage, apiKey: string): AsyncIterable<PeerEvent> {
    const {query} = await import('@anthropic-ai/claude-agent-sdk')

    const savedSessionId = this.sessions.getClaudeSessionId(this.id)
    const prompt = this.buildPrompt(msg)

    const stream = query({
      prompt,
      options: {
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'acceptEdits',
        maxTurns: 30,
        cwd: this.worktreePath,
        // Pass API key via env option — clean, no process.env mutation, no race condition
        env: {ANTHROPIC_API_KEY: apiKey},
        ...(savedSessionId ? {resume: savedSessionId} : {}),
        canUseTool: async (toolName: string, input: unknown) => {
          if (toolName === 'Bash') {
            const cmd = (input as {command?: string}).command ?? ''
            if (BLOCKED_BASH.test(cmd)) {
              return {behavior: 'deny' as const, message: 'Blocked by MetaCLiDE: deploy/destructive ops not allowed'}
            }
          }
          return {behavior: 'allow' as const}
        },
      },
    })

    for await (const event of stream) {
      const e = event as Record<string, unknown>

      if (e.type === 'system' && e.subtype === 'init') {
        const sid = e.session_id as string | undefined
        if (sid) {
          this.sessions.setClaudeSessionId(this.id, sid)
        }
        continue
      }

      if (e.type === 'assistant') {
        const message = e.message as Record<string, unknown>
        const content = message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>
            if (b.type === 'text') {
              const text = String(b.text ?? '')
              this.logger.append({type: 'text', content: text, taskId: msg.taskId})
              yield {type: 'text', content: text}
            } else if (b.type === 'tool_use') {
              const name = String(b.name)
              this.logger.append({type: 'tool_use', toolName: name, toolInput: b.input, taskId: msg.taskId})
              yield {type: 'tool_use', toolName: name, toolInput: b.input}
            }
          }
        }
        continue
      }

      if (e.type === 'result') {
        const cost = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0
        const turns = typeof e.num_turns === 'number' ? e.num_turns : 0
        const isError = e.is_error === true
        if (isError) {
          const errMsg = Array.isArray(e.errors) ? (e.errors as string[]).join('; ') : String(e.subtype ?? 'error')
          this.logger.append({type: 'error', content: errMsg, taskId: msg.taskId})
          yield {type: 'error', error: errMsg}
          return
        }
        const result = typeof e.result === 'string' ? e.result : ''
        this.logger.append({type: 'result', content: result, costUsd: cost, turns, taskId: msg.taskId})
        yield {type: 'result', content: result, costUsd: cost, turns}
        return
      }
    }
  }

  private async *sendViaCLI(msg: PeerMessage, apiKey: string): AsyncIterable<PeerEvent> {
    const {execa} = await import('execa')
    const prompt = this.buildPrompt(msg)
    const savedSessionId = this.sessions.getClaudeSessionId(this.id)

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep',
      '--permission-mode', 'acceptEdits',
      '--max-turns', '30',
    ]
    if (savedSessionId) args.push('--resume', savedSessionId)

    try {
      const proc = execa('claude', args, {
        cwd: this.worktreePath,
        env: {...process.env, ANTHROPIC_API_KEY: apiKey},
        stdio: ['ignore', 'pipe', 'pipe'],
        reject: false,
      })

      let buffer = ''
      for await (const chunk of proc.iterable()) {
        buffer += String(chunk)
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line) as Record<string, unknown>

            if (event.type === 'system' && event.subtype === 'init') {
              const sid = event.session_id as string | undefined
              if (sid) this.sessions.setClaudeSessionId(this.id, sid)
              continue
            }

            if (event.type === 'assistant') {
              const message = event.message as Record<string, unknown>
              const content = message?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  const b = block as Record<string, unknown>
                  if (b.type === 'text') yield {type: 'text', content: String(b.text ?? '')}
                }
              }
              continue
            }

            if (event.type === 'result') {
              yield {
                type: 'result',
                content: String(event.result ?? ''),
                costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0,
                turns: typeof event.num_turns === 'number' ? event.num_turns : 0,
              }
              return
            }
          } catch { /* skip non-JSON lines */ }
        }
      }
      await proc
    } catch (err) {
      yield {type: 'error', error: String(err)}
    }
  }

  async ackContract(version: number, hash: string): Promise<void> {
    const status = this.orch.readPeerStatus(this.id) ?? {
      peer: this.id, contractVersion: 0, contractHash: '',
      activeTasks: [], blockedBy: null, lastCommit: '',
      branch: this.config.branch, lastGateResult: {}, notes: '',
    }
    status.contractVersion = version
    status.contractHash = hash
    this.orch.writePeerStatus(status)
  }

  async writeStatus(update: PeerStatusUpdate): Promise<void> {
    const existing = this.orch.readPeerStatus(this.id)
    this.orch.writePeerStatus({
      peer: this.id,
      contractVersion: existing?.contractVersion ?? 0,
      contractHash: existing?.contractHash ?? '',
      branch: this.config.branch,
      ...existing,
      ...update,
    })
  }

  async shutdown(): Promise<void> {
    this.logger.append({type: 'system', content: 'shutdown'})
  }

  private buildPrompt(msg: PeerMessage): string {
    const header = [
      `[METACLIDE — ${msg.type.toUpperCase()} PHASE]`,
      `You are ${this.config.displayName} (id: ${this.id}), role: ${this.role}`,
      `Worktree: ${this.worktreePath}`,
      `Contracts (READ-ONLY): ${this.repoRoot}/.orch/contracts/`,
      `Status file: ${this.repoRoot}/.orch/status/${this.id}.json`,
      '',
      'RULES: Never modify .orch/contracts/ — file a CR instead.',
      'Commit frequently. Work only inside your worktree.',
    ].join('\n')

    const body = msg.content
    const attachments = msg.attachments?.map(a => `--- ${a.path} ---\n${a.content}`).join('\n\n') ?? ''

    return [header, '', body, attachments ? `\n## Attached Files\n\n${attachments}` : ''].join('\n')
  }
}
