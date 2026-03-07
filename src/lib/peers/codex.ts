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
    // Conductor needs full access to write contracts into .orch (which is a junction)
    const sandbox = this.role === 'conductor' ? 'danger-full-access' : 'workspace-write'
    // Flags MUST come before the prompt — otherwise Codex CLI ignores them
    const args = savedThreadId
      ? ['exec', '--json', '--full-auto', '--sandbox', sandbox, ...modelArgs, 'resume', savedThreadId, prompt]
      : ['exec', '--json', '--full-auto', '--sandbox', sandbox, ...modelArgs, prompt]

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
        // Codex emits JSON objects without newlines — split on }{ boundary
        const objects = buffer.split(/\}\s*\{/).map((s, i, arr) =>
          (i > 0 ? '{' : '') + s + (i < arr.length - 1 ? '}' : '')
        )
        buffer = objects.pop() ?? ''

        for (const fragment of objects) {
          if (!fragment.trim()) continue
          try {
            const event = JSON.parse(fragment) as Record<string, unknown>
            yield* this.mapCodexEvent(event, msg.taskId, itemTypes, itemText)
          } catch { /* non-JSON fragment, ignore */ }
        }
      }

      // Flush remaining buffer (last complete JSON object)
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as Record<string, unknown>
          yield* this.mapCodexEvent(event, msg.taskId, itemTypes, itemText)
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
      // thread_id may be at top level or inside event
      const tid = (event.thread_id ?? event.threadId) as string | undefined
      if (tid) this.sessions.setCodexThreadId(this.id, tid)
      return
    }

    // Codex events may have item data at top level (item_id, item_type)
    // OR nested inside an `item` object — handle both formats
    const item = event.item as Record<string, unknown> | undefined
    const itemId = (event.item_id ?? item?.id) as string | undefined
    const itemType = (event.item_type ?? item?.type) as string | undefined

    if (type === 'item.started') {
      if (itemId && itemType) itemTypes.set(itemId, itemType)
      return
    }

    if (type === 'item.updated') {
      const id = itemId ?? ''
      const iType = itemTypes.get(id) ?? itemType ?? ''
      if (iType === 'agent_message' || iType === 'reasoning') {
        // Codex sends accumulated text; compute delta
        const full = String(event.content ?? item?.text ?? '')
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
      const iType = itemType ?? itemTypes.get(itemId ?? '') ?? ''
      if (iType === 'agent_message' || iType === 'reasoning') {
        // Short responses: Codex skips item.updated, sends text directly in item.completed
        const full = String(item?.text ?? event.content ?? '')
        const prev = itemText.get(itemId ?? '') ?? ''
        const delta = full.length > prev.length ? full.slice(prev.length) : (prev.length === 0 ? full : '')
        if (delta) {
          itemText.set(itemId ?? '', full)
          this.logger.append({type: 'text', content: delta, taskId})
          yield {type: 'text', content: delta}
        }
      } else if (iType === 'file_change') {
        const toolInput = {path: event.path ?? item?.path, operation: event.operation ?? item?.operation}
        this.logger.append({type: 'tool_use', toolName: 'file_change', toolInput, taskId})
        yield {type: 'tool_use', toolName: 'file_change', toolInput}
      } else if (iType === 'command_execution' || iType === 'command') {
        const toolInput = {command: event.command ?? item?.command}
        this.logger.append({type: 'tool_use', toolName: 'command', toolInput, taskId})
        yield {type: 'tool_use', toolName: 'command', toolInput}
      } else if (iType === 'mcp_tool_call') {
        const name = event.name ?? item?.name
        const input = event.input ?? item?.input
        yield {type: 'tool_use', toolName: String(name ?? 'mcp'), toolInput: {name, input}}
      }
      return
    }

    if (type === 'turn.completed') {
      const usage = event.usage as {input_tokens?: number; output_tokens?: number} | undefined
      // Codex default model pricing (o4-mini: ~$1.10/$4.40 per M tokens)
      const costUsd = usage
        ? ((usage.input_tokens ?? 0) * 0.0000011 + (usage.output_tokens ?? 0) * 0.0000044)
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
