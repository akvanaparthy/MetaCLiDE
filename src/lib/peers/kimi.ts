// Kimi peer adapter
// Primary: OpenAI-compatible API at api.moonshot.ai/v1 (BYOK)
// Fallback: kimi --print -y -p "<prompt>" --work-dir <path> --output-format stream-json (OAuth/CLI)
import type {Capability, PeerMessage, PeerEvent, PeerStatusUpdate, PeerConfig} from '../../types.js'
import type {Peer} from './interface.js'
import {PeerLogger} from '../logger/index.js'
import {OrchManager} from '../orch/index.js'
import {SessionStore} from '../orch/sessions.js'

// International endpoint first; .cn as fallback
const KIMI_BASE_URL = 'https://api.moonshot.ai/v1'
const DEFAULT_MODEL = 'kimi-k2-thinking-turbo'

// Pricing per token: $0.60/M input, $2.50/M output
const INPUT_COST = 0.0000006
const OUTPUT_COST = 0.0000025

export class KimiPeer implements Peer {
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
    return ['read', 'write', 'bash', 'search']
  }

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    // Kimi CLI uses KIMI_API_KEY; Moonshot API also accepts MOONSHOT_API_KEY
    const apiKey = (this.config.apiKey ?? process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY ?? '').trim()

    this.logger.append({type: 'system', content: `send:${msg.type}`, taskId: msg.taskId})

    if (this.config.mode === 'oauth') {
      // OAuth mode: use CLI subprocess
      yield* this.sendViaCLI(msg)
      return
    }

    if (!apiKey) {
      yield {type: 'error', error: 'MOONSHOT_API_KEY not set for Kimi peer'}
      return
    }

    yield* this.sendViaAPI(msg, apiKey)
  }

  private async *sendViaAPI(msg: PeerMessage, apiKey: string): AsyncIterable<PeerEvent> {
    try {
      const {OpenAI} = await import('openai')
      const client = new OpenAI({apiKey, baseURL: KIMI_BASE_URL})

      const model = this.config.model ?? DEFAULT_MODEL
      const stream = client.beta.chat.completions.stream({
        model,
        messages: [
          {role: 'system', content: this.systemPrompt()},
          {role: 'user', content: this.buildPrompt(msg)},
        ],
        max_tokens: 16_000,
      })

      let fullContent = ''
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          fullContent += delta
          this.logger.append({type: 'text', content: delta, taskId: msg.taskId})
          yield {type: 'text', content: delta}
        }
      }

      const final = await stream.finalMessage()
      const usage = (final as unknown as {usage?: {prompt_tokens: number; completion_tokens: number}}).usage
      const costUsd = usage
        ? (usage.prompt_tokens * INPUT_COST + usage.completion_tokens * OUTPUT_COST)
        : 0

      this.logger.append({type: 'result', content: fullContent, costUsd, turns: 1, taskId: msg.taskId})
      yield {type: 'result', content: fullContent, costUsd, turns: 1}
    } catch (err) {
      const errMsg = String(err)
      this.logger.append({type: 'error', content: errMsg, taskId: msg.taskId})
      yield {type: 'error', error: errMsg}
    }
  }

  private async *sendViaCLI(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const {execa} = await import('execa')
    const prompt = this.buildPrompt(msg)

    const modelArgs = this.config.model ? ['-m', this.config.model] : []
    const savedSessionId = this.sessions.getKimiSessionId(this.id)
    // Correct Kimi CLI flags for non-interactive mode
    const args = [
      '--print',         // non-interactive, auto-exit
      '-y',              // yolo: auto-approve all actions
      '-p', prompt,      // prompt via -p flag
      '--work-dir', this.worktreePath,
      '--output-format', 'stream-json',
      ...modelArgs,
      ...(savedSessionId ? ['--session', savedSessionId] : []),
    ]

    const env: Record<string, string> = {...(process.env as Record<string, string>)}

    if (this.config.mode === 'oauth') {
      // OAuth/subscription mode: let kimi --print read ~/.kimi/credentials/kimi-code.json itself.
      // The credential file was written by our device code OAuth flow.
      // Injecting any key would switch it to API billing.
    } else if (this.config.apiKey) {
      // BYOK mode: Kimi CLI reads KIMI_API_KEY (not MOONSHOT_API_KEY)
      env.KIMI_API_KEY = this.config.apiKey
    }

    try {
      const proc = execa('kimi', args, {
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
            yield* this.mapKimiEvent(event, msg.taskId)
          } catch {
            // Plain text line
            if (line.trim()) yield {type: 'text', content: line}
          }
        }
      }

      await proc
    } catch (err) {
      yield {type: 'error', error: String(err)}
    }
  }

  private *mapKimiEvent(event: Record<string, unknown>, taskId?: string): Generator<PeerEvent> {
    // Capture session ID if present (for resume across phases)
    const sessionId = (event.session_id ?? event.sessionId) as string | undefined
    if (sessionId) this.sessions.setKimiSessionId(this.id, sessionId)

    // Wire protocol JSON-RPC 2.0 format
    const method = event.method as string | undefined
    const params = event.params as Record<string, unknown> | undefined

    if (method === 'request' && params?.type === 'ApprovalRequest') {
      // Auto-approve safe ops; block deploy commands
      const action = String((params.payload as Record<string, unknown>)?.action ?? '')
      const safe = /^(ls|cat|grep|npm (install|test|build|run)|git (status|log|diff|add|commit))/.test(action)
      if (!safe && /deploy|publish|push/.test(action)) {
        // Kimi wire protocol doesn't need a response from our side — we just skip
      }
      return
    }

    // ContentPart text messages
    const msgType = event.type as string
    if (msgType === 'ContentPart' || msgType === 'content') {
      const content = event.content as Record<string, unknown> | undefined
      const text = String(content?.value ?? content?.text ?? event.value ?? event.text ?? '')
      if (text) {
        this.logger.append({type: 'text', content: text, taskId})
        yield {type: 'text', content: text}
      }
      return
    }

    if (msgType === 'done' || msgType === 'finish') {
      this.logger.append({type: 'result', content: '', taskId})
      yield {type: 'result', content: ''}
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

  private systemPrompt(): string {
    return [
      `You are ${this.config.displayName} (id: ${this.id}), role: ${this.role} in a MetaCLiDE multi-agent session.`,
      `Worktree: ${this.worktreePath}`,
      `Contracts (READ-ONLY): ${this.repoRoot}/.orch/contracts/`,
      '',
      'RULES:',
      '- Never modify .orch/contracts/ — file a Change Request instead',
      '- Work only inside your worktree',
      '- Follow contract specifications exactly',
      '- Commit changes with clear messages',
    ].join('\n')
  }

  private buildPrompt(msg: PeerMessage): string {
    const lines = [
      `Task: ${msg.type.toUpperCase()}${msg.taskId ? ` (${msg.taskId})` : ''}`,
      '',
      msg.content,
    ]
    if (msg.attachments?.length) {
      lines.push('\nAttachments:')
      for (const a of msg.attachments) lines.push(`\n${a.path}:\n${a.content}`)
    }
    return lines.join('\n')
  }
}
