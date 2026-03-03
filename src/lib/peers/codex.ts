// Codex CLI peer adapter - spawns `codex exec` subprocess
import type {Capability, PeerMessage, PeerEvent, PeerStatusUpdate, PeerConfig} from '../../types.js'
import type {Peer} from './interface.js'
import {PeerLogger} from '../logger/index.js'
import {OrchManager} from '../orch/index.js'

export class CodexPeer implements Peer {
  readonly mode: 'tool' | 'api'
  readonly role: 'conductor' | 'implementer'

  private logger: PeerLogger
  private orch: OrchManager
  private lastThreadId: string | null = null

  constructor(
    private readonly config: PeerConfig,
    private readonly repoRoot: string,
    private readonly worktreePath: string
  ) {
    this.role = config.role
    this.mode = config.mode === 'oauth' ? 'tool' : 'api'
    this.logger = new PeerLogger(repoRoot, config.id)
    this.orch = new OrchManager(repoRoot)
  }

  get id(): string {
    return this.config.id
  }

  capabilities(): Capability[] {
    return ['read', 'write', 'bash', 'browser', 'search', 'test']
  }

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const prompt = this.buildPrompt(msg)

    this.logger.append({
      type: 'system',
      content: `Sending ${msg.type} to Codex`,
      taskId: msg.taskId,
    })

    // Build codex command
    const args = ['exec', prompt, '--json', '--approval-policy', 'never']

    // Set env
    const env: Record<string, string> = {...(process.env as Record<string, string>)}
    if (this.config.apiKey) env.OPENAI_API_KEY = this.config.apiKey
    if (this.config.model) env.CODEX_MODEL = this.config.model

    try {
      const {execa} = await import('execa')
      const proc = execa('codex', args, {
        cwd: this.worktreePath,
        env,
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
            yield* this.processCodexEvent(event, msg.taskId)
          } catch {
            // Non-JSON line
            if (line.trim()) {
              yield {type: 'text', content: line}
            }
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as Record<string, unknown>
          yield* this.processCodexEvent(event, msg.taskId)
        } catch {
          yield {type: 'text', content: buffer}
        }
      }
    } catch (err) {
      const errMsg = String(err)
      this.logger.append({type: 'error', content: errMsg, taskId: msg.taskId})
      yield {type: 'error', error: errMsg}
    }
  }

  private *processCodexEvent(
    event: Record<string, unknown>,
    taskId?: string
  ): Generator<PeerEvent> {
    if (event.type === 'message' && event.role === 'assistant') {
      const content = String(event.content ?? '')
      this.logger.append({type: 'text', content, taskId})
      yield {type: 'text', content}
    } else if (event.type === 'tool_call') {
      const toolName = String(event.name ?? '')
      this.logger.append({type: 'tool_use', toolName, toolInput: event.input, taskId})
      yield {type: 'tool_use', toolName, toolInput: event.input}
    } else if (event.type === 'session') {
      this.lastThreadId = String(event.id ?? '')
    } else if (event.type === 'done') {
      const result = String(event.summary ?? '')
      this.logger.append({type: 'result', content: result, taskId})
      yield {type: 'result', content: result}
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
    this.logger.append({type: 'system', content: 'Codex peer shutdown'})
  }

  getLastThreadId(): string | null {
    return this.lastThreadId
  }

  private buildPrompt(msg: PeerMessage): string {
    const context = `
[MetaCLiDE] You are ${this.config.displayName} (peer id: ${this.id}), a ${this.role} in a multi-agent session.
Worktree: ${this.worktreePath}
Contracts (READ-ONLY): ${this.repoRoot}/.orch/contracts/

Task type: ${msg.type}${msg.taskId ? ` | Task ID: ${msg.taskId}` : ''}

${msg.content}`.trim()

    if (msg.attachments && msg.attachments.length > 0) {
      return (
        context +
        '\n\nAttached files:\n' +
        msg.attachments.map(a => `${a.path}:\n${a.content}`).join('\n\n')
      )
    }
    return context
  }
}
