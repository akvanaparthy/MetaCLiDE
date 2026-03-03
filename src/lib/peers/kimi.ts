// Kimi Code peer adapter - uses OpenAI-compatible API at api.moonshot.cn/v1
import type {Capability, PeerMessage, PeerEvent, PeerStatusUpdate, PeerConfig} from '../../types.js'
import type {Peer} from './interface.js'
import {PeerLogger} from '../logger/index.js'
import {OrchManager} from '../orch/index.js'

const KIMI_BASE_URL = 'https://api.moonshot.cn/v1'
const DEFAULT_MODEL = 'kimi-k2-thinking-turbo'

export class KimiPeer implements Peer {
  readonly mode: 'tool' | 'api'
  readonly role: 'conductor' | 'implementer'

  private logger: PeerLogger
  private orch: OrchManager

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
    return ['read', 'write', 'bash', 'search']
  }

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const apiKey = (this.config.apiKey ?? process.env.MOONSHOT_API_KEY ?? '').trim()
    if (!apiKey) {
      yield {type: 'error', error: 'MOONSHOT_API_KEY not set for Kimi peer'}
      return
    }

    this.logger.append({
      type: 'system',
      content: `Sending ${msg.type} to Kimi`,
      taskId: msg.taskId,
    })

    // If OAuth mode, try CLI first
    if (this.config.mode === 'oauth') {
      yield* this.sendViaCLI(msg)
      return
    }

    // BYOK: use OpenAI-compatible API
    yield* this.sendViaAPI(msg, apiKey)
  }

  private async *sendViaAPI(msg: PeerMessage, apiKey: string): AsyncIterable<PeerEvent> {
    try {
      const {OpenAI} = await import('openai')
      const client = new OpenAI({apiKey, baseURL: KIMI_BASE_URL})

      const prompt = this.buildPrompt(msg)
      const model = this.config.model ?? DEFAULT_MODEL

      const stream = client.beta.chat.completions.stream({
        model,
        messages: [
          {
            role: 'system',
            content: this.systemPrompt(),
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 16000,
      })

      let fullContent = ''
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          fullContent += delta
          yield {type: 'text', content: delta}
        }
      }

      const finalMessage = await stream.finalMessage()
      const usage = (finalMessage as unknown as {usage?: {prompt_tokens: number; completion_tokens: number}}).usage
      const costUsd = usage
        ? (usage.prompt_tokens * 0.000012 + usage.completion_tokens * 0.000012)
        : 0

      this.logger.append({
        type: 'result',
        content: fullContent,
        costUsd,
        turns: 1,
        taskId: msg.taskId,
      })
      yield {type: 'result', content: fullContent, costUsd, turns: 1}
    } catch (err) {
      const errMsg = String(err)
      this.logger.append({type: 'error', content: errMsg, taskId: msg.taskId})
      yield {type: 'error', error: errMsg}
    }
  }

  private async *sendViaCLI(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const prompt = this.buildPrompt(msg)
    try {
      const {execa} = await import('execa')
      const proc = execa('kimi', ['--print', prompt, '--json'], {
        cwd: this.worktreePath,
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
            if (event.type === 'content') {
              const text = String(event.content ?? '')
              yield {type: 'text', content: text}
            } else if (event.type === 'done') {
              yield {type: 'result', content: String(event.summary ?? '')}
            }
          } catch {
            yield {type: 'text', content: line}
          }
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
    this.logger.append({type: 'system', content: 'Kimi peer shutdown'})
  }

  private systemPrompt(): string {
    return `You are ${this.config.displayName} (id: ${this.id}), a ${this.role} in a MetaCLiDE multi-agent coding session.
Your worktree: ${this.worktreePath}
Contracts (READ-ONLY): ${this.repoRoot}/.orch/contracts/

Rules:
- Never modify .orch/contracts/ directly
- Work only in your worktree
- Follow contract specifications exactly
- Commit changes with clear messages`
  }

  private buildPrompt(msg: PeerMessage): string {
    const lines = [`Task: ${msg.type.toUpperCase()}${msg.taskId ? ` (${msg.taskId})` : ''}`, '', msg.content]
    if (msg.attachments && msg.attachments.length > 0) {
      lines.push('\nAttachments:')
      for (const a of msg.attachments) lines.push(`\n${a.path}:\n${a.content}`)
    }
    return lines.join('\n')
  }
}
