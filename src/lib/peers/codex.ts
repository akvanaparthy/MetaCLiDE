// Codex peer adapter — codex exec subprocess (OAuth) or @openai/codex-sdk (BYOK)
// Real NDJSON event format from `codex exec --json`:
//   thread.started, turn.started, item.started, item.updated, item.completed, turn.completed
import type {Capability, PeerMessage, PeerEvent, PeerStatusUpdate, PeerConfig} from '../../types.js'
import type {Peer} from './interface.js'
import {PeerLogger} from '../logger/index.js'
import {OrchManager} from '../orch/index.js'
import {SessionStore} from '../orch/sessions.js'

export class CodexPeer implements Peer {
  readonly mode: 'tool' | 'api'
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
    this.mode = config.mode === 'oauth' ? 'tool' : 'api'
    this.logger = new PeerLogger(repoRoot, config.id)
    this.orch = new OrchManager(repoRoot)
    this.sessions = new SessionStore(repoRoot)
  }

  get id(): string { return this.config.id }

  capabilities(): Capability[] {
    return ['read', 'write', 'bash', 'browser', 'search', 'test']
  }

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    this.logger.append({type: 'system', content: `send:${msg.type}`, taskId: msg.taskId})

    // Try SDK for BYOK mode
    if (this.config.mode === 'byok' && this.config.apiKey) {
      try {
        yield* this.sendViaSDK(msg)
        return
      } catch { /* fall through to CLI */ }
    }

    yield* this.sendViaCLI(msg)
  }

  private async *sendViaSDK(msg: PeerMessage): AsyncIterable<PeerEvent> {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — @openai/codex-sdk is optional; falls back to CLI if not installed
    const {Codex} = await import('@openai/codex-sdk')
    const codex = new Codex({apiKey: this.config.apiKey!, cwd: this.worktreePath})

    const savedThreadId = this.sessions.getCodexThreadId(this.id)
    const thread = savedThreadId ? codex.resumeThread(savedThreadId) : codex.startThread({workingDirectory: this.worktreePath})

    const prompt = this.buildPrompt(msg)

    for await (const event of thread.runStreamed(prompt)) {
      const e = event as Record<string, unknown>
      if (e.type === 'thread.started') {
        const tid = e.thread_id as string | undefined
        if (tid) this.sessions.setCodexThreadId(this.id, tid)
        continue
      }
      yield* this.mapCodexEvent(e, msg.taskId)
    }
  }

  private async *sendViaCLI(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const {execa} = await import('execa')
    const prompt = this.buildPrompt(msg)
    const savedThreadId = this.sessions.getCodexThreadId(this.id)

    const modelArgs = this.config.model ? ['-m', this.config.model] : []
    const args = savedThreadId
      ? ['exec', 'resume', savedThreadId, prompt, '--json', '--approval-policy', 'never', ...modelArgs]
      : ['exec', prompt, '--json', '--approval-policy', 'never', '--sandbox', 'workspace-write', ...modelArgs]

    const env: Record<string, string> = {...(process.env as Record<string, string>)}

    if (this.config.mode === 'oauth') {
      // OAuth/subscription mode: let codex exec read ~/.codex/auth.json itself.
      // Injecting CODEX_API_KEY would switch it to API billing and bypass the subscription.
      // The credential file was written by our OAuth flow — the CLI handles the rest.
    } else if (this.config.apiKey) {
      // BYOK mode: inject the API key explicitly
      env.CODEX_API_KEY = this.config.apiKey
      env.OPENAI_API_KEY = this.config.apiKey
    }

    try {
      const proc = execa('codex', args, {
        cwd: this.worktreePath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        reject: false,
      })

      let buffer = ''
      // Per-item text accumulation for streaming deltas
      const itemTypes = new Map<string, string>()
      const itemText = new Map<string, string>()

      for await (const chunk of proc.iterable()) {
        buffer += String(chunk)
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line) as Record<string, unknown>
            yield* this.mapCodexEvent(event, msg.taskId, itemTypes, itemText)
          } catch { /* non-JSON line, ignore */ }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as Record<string, unknown>
          yield* this.mapCodexEvent(event, msg.taskId)
        } catch { /* skip */ }
      }

      await proc
    } catch (err) {
      yield {type: 'error', error: String(err)}
    }
  }

  private *mapCodexEvent(
    event: Record<string, unknown>,
    taskId?: string,
    itemTypes: Map<string, string> = new Map(),
    itemText: Map<string, string> = new Map()
  ): Generator<PeerEvent> {
    const type = event.type as string

    if (type === 'thread.started') {
      const tid = event.thread_id as string | undefined
      if (tid) this.sessions.setCodexThreadId(this.id, tid)
      return
    }

    if (type === 'item.started') {
      const id = event.item_id as string
      const itemType = event.item_type as string
      if (id && itemType) itemTypes.set(id, itemType)
      return
    }

    if (type === 'item.updated') {
      const id = event.item_id as string
      const iType = itemTypes.get(id) ?? ''
      if (iType === 'agent_message' || iType === 'reasoning') {
        // Codex sends accumulated text; compute delta
        const full = String(event.content ?? '')
        const prev = itemText.get(id) ?? ''
        const delta = full.length > prev.length ? full.slice(prev.length) : ''
        if (delta) {
          itemText.set(id, full)
          this.logger.append({type: 'text', content: delta, taskId})
          yield {type: 'text', content: delta}
        }
      }
      return
    }

    if (type === 'item.completed') {
      const iType = event.item_type as string
      if (iType === 'file_change') {
        const toolInput = {path: event.path, operation: event.operation}
        this.logger.append({type: 'tool_use', toolName: 'file_change', toolInput, taskId})
        yield {type: 'tool_use', toolName: 'file_change', toolInput}
      } else if (iType === 'command_execution') {
        const toolInput = {command: event.command}
        this.logger.append({type: 'tool_use', toolName: 'command', toolInput, taskId})
        yield {type: 'tool_use', toolName: 'command', toolInput}
      } else if (iType === 'mcp_tool_call') {
        const toolInput = {name: event.name, input: event.input}
        yield {type: 'tool_use', toolName: String(event.name ?? 'mcp'), toolInput}
      }
      return
    }

    if (type === 'turn.completed') {
      const usage = event.usage as {input_tokens?: number; output_tokens?: number} | undefined
      // Pricing: $0.0000015/input token, $0.000006/output token (gpt-4o-mini scale)
      const costUsd = usage
        ? ((usage.input_tokens ?? 0) * 0.0000015 + (usage.output_tokens ?? 0) * 0.000006)
        : 0
      this.logger.append({type: 'result', content: '', costUsd, turns: 1, taskId})
      yield {type: 'result', content: '', costUsd, turns: 1}
      return
    }

    if (type === 'error' || type === 'turn.failed') {
      const errMsg = String(event.message ?? event.error ?? 'Codex error')
      this.logger.append({type: 'error', content: errMsg, taskId})
      yield {type: 'error', error: errMsg}
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
      '',
      'RULES: Never modify .orch/contracts/ — file a CR instead.',
      'Commit frequently. Work only inside your worktree.',
    ].join('\n')

    const lines = [header, '', msg.content]
    if (msg.attachments?.length) {
      lines.push('\nAttached files:')
      for (const a of msg.attachments) lines.push(`\n${a.path}:\n${a.content}`)
    }
    return lines.join('\n')
  }
}
