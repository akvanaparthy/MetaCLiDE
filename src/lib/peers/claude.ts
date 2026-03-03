// Claude Code peer adapter - uses @anthropic-ai/claude-code SDK (query function)
import type {Capability, PeerMessage, PeerEvent, PeerStatusUpdate, PeerConfig} from '../../types.js'
import type {Peer} from './interface.js'
import {PeerLogger} from '../logger/index.js'
import {OrchManager} from '../orch/index.js'

export class ClaudePeer implements Peer {
  readonly mode = 'api' as const
  readonly role: 'conductor' | 'implementer'

  private logger: PeerLogger
  private worktreePath: string
  private orch: OrchManager

  constructor(
    private readonly config: PeerConfig,
    private readonly repoRoot: string,
    worktreePath: string
  ) {
    this.role = config.role
    this.worktreePath = worktreePath
    this.logger = new PeerLogger(repoRoot, config.id)
    this.orch = new OrchManager(repoRoot)
  }

  get id(): string {
    return this.config.id
  }

  capabilities(): Capability[] {
    return ['read', 'write', 'bash', 'search', 'test']
  }

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const apiKey = (this.config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim()
    if (!apiKey) {
      yield {type: 'error', error: 'ANTHROPIC_API_KEY not set for Claude peer'}
      return
    }

    this.logger.append({
      type: 'system',
      content: `Sending ${msg.type} message`,
      taskId: msg.taskId,
      phase: msg.type,
    })

    // Try to use @anthropic-ai/claude-code SDK
    try {
      const {query} = await import('@anthropic-ai/claude-code')

      const prompt = this.buildPrompt(msg)
      // Set API key in process env for the SDK
      const prevKey = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = apiKey
      const stream = query({
        prompt,
        options: {
          allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
          permissionMode: 'acceptEdits',
          maxTurns: 30,
          cwd: this.worktreePath,
        },
      })
      // Restore env after starting stream
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey

      for await (const event of stream) {
        const e = event as Record<string, unknown>
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
                this.logger.append({type: 'tool_use', toolName: String(b.name), toolInput: b.input, taskId: msg.taskId})
                yield {type: 'tool_use', toolName: String(b.name), toolInput: b.input}
              }
            }
          }
        } else if (e.type === 'result') {
          const cost = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0
          const turns = typeof e.num_turns === 'number' ? e.num_turns : 0
          const result = typeof e.result === 'string' ? e.result : ''
          this.logger.append({type: 'result', content: result, costUsd: cost, turns, taskId: msg.taskId})
          yield {type: 'result', content: result, costUsd: cost, turns}
          return
        } else if (e.type === 'system' && e.subtype === 'error') {
          const errMsg = String(e.error ?? 'Unknown error')
          this.logger.append({type: 'error', content: errMsg, taskId: msg.taskId})
          yield {type: 'error', error: errMsg}
          return
        }
      }
    } catch (importErr) {
      // Fallback: use claude CLI subprocess
      yield* this.sendViaCLI(msg, apiKey)
    }
  }

  private async *sendViaCLI(msg: PeerMessage, apiKey: string): AsyncIterable<PeerEvent> {
    const {execa} = await import('execa')
    const prompt = this.buildPrompt(msg)

    try {
      const proc = execa('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose'], {
        cwd: this.worktreePath,
        env: {...process.env, ANTHROPIC_API_KEY: apiKey},
        stdio: ['ignore', 'pipe', 'pipe'],
        reject: false,
      })

      for await (const line of proc.iterable()) {
        try {
          const event = JSON.parse(String(line)) as Record<string, unknown>
          if (event.type === 'assistant') {
            const message = event.message as Record<string, unknown>
            const content = message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as Record<string, unknown>
                if (b.type === 'text') {
                  yield {type: 'text', content: String(b.text ?? '')}
                }
              }
            }
          } else if (event.type === 'result') {
            yield {
              type: 'result',
              content: String(event.result ?? ''),
              costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0,
              turns: typeof event.num_turns === 'number' ? event.num_turns : 0,
            }
            return
          }
        } catch {
          // non-JSON line, skip
        }
      }
    } catch (err) {
      yield {type: 'error', error: String(err)}
    }
  }

  async ackContract(version: number, hash: string): Promise<void> {
    const status = this.orch.readPeerStatus(this.id) ?? {
      peer: this.id,
      contractVersion: 0,
      contractHash: '',
      activeTasks: [],
      blockedBy: null,
      lastCommit: '',
      branch: this.config.branch,
      lastGateResult: {},
      notes: '',
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
    this.logger.append({type: 'system', content: 'Peer shutdown'})
  }

  private buildPrompt(msg: PeerMessage): string {
    const orchContext = `
You are ${this.config.displayName} (peer id: ${this.id}), working as a ${this.role} in a MetaCLiDE multi-agent session.
Your worktree is at: ${this.worktreePath}
Contracts are in: ${this.repoRoot}/.orch/contracts/
Your status is tracked at: ${this.repoRoot}/.orch/status/${this.id}.json

INVARIANTS:
1. Contracts (.orch/contracts/) are truth. Never modify them directly — file a CR instead.
2. Work only within your worktree: ${this.worktreePath}
3. Commit frequently with descriptive messages.
4. Follow the acceptance criteria exactly.
`.trim()

    const attachments = msg.attachments?.map(a => `--- ${a.path} ---\n${a.content}`).join('\n\n') ?? ''

    return [
      orchContext,
      '',
      `## Task: ${msg.type.toUpperCase()}${msg.taskId ? ` (${msg.taskId})` : ''}`,
      '',
      msg.content,
      attachments ? `\n## Attached Files\n\n${attachments}` : '',
    ].join('\n')
  }
}
