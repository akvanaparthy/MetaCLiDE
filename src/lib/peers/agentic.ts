// AgenticApiPeer — Kilocode-style agentic loop over any OpenAI-compatible API.
//
// Exposes a standard tool set to the model (read_file, write_file, edit_file,
// run_bash, search_files, list_dir, task_complete) and executes them locally
// inside the peer's worktree. Works with any provider that supports function
// calling: OpenAI, Moonshot/Kimi, Groq, Together, DeepSeek, Ollama, etc.
//
// This is the fallback for Codex/Kimi when the CLI is not installed.
// It gives every API key the same full file-editing capabilities as a CLI tool.

import fs from 'node:fs'
import path from 'node:path'
import type {Capability, PeerMessage, PeerEvent, PeerStatusUpdate, PeerConfig} from '../../types.js'
import type {Peer} from './interface.js'
import {PeerLogger} from '../logger/index.js'
import {OrchManager} from '../orch/index.js'

// Commands MetaCLiDE will never execute on behalf of a peer
const BLOCKED_CMDS = /git\s+push|rm\s+-rf|npm\s+publish|curl.+deploy|npx.+deploy|vercel|heroku/

const MAX_TURNS = 50
const MAX_OUTPUT = 8_000   // max chars returned from bash/read to avoid context explosion
const MAX_SEARCH = 3_000

// ── Tool definitions (OpenAI function-calling format) ──

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the full contents of a file in your worktree.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string', description: 'File path relative to worktree root'},
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Create or completely overwrite a file with new content.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string'},
          content: {type: 'string'},
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file. old_string must be unique within the file.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string'},
          old_string: {type: 'string', description: 'Exact text to replace (must be unique in file)'},
          new_string: {type: 'string', description: 'Replacement text'},
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_dir',
      description: 'Create a directory (and any needed parents).',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string'},
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_file',
      description: 'Delete a file from your worktree.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string'},
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_bash',
      description: 'Run a shell command inside your worktree. Timeout: 30s. Avoid deploy/push commands.',
      parameters: {
        type: 'object',
        properties: {
          command: {type: 'string'},
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: 'Search for a regex pattern across files in your worktree.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {type: 'string', description: 'Regex to search for'},
          dir: {type: 'string', description: 'Sub-directory to search in (optional)'},
          glob: {type: 'string', description: 'File glob e.g. "*.ts" (optional)'},
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: 'List files and directories in your worktree.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string', description: 'Directory path relative to worktree root (optional)'},
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task_complete',
      description: 'Call this when your task is fully done and all files are committed.',
      parameters: {
        type: 'object',
        properties: {
          summary: {type: 'string', description: 'Brief summary of what was implemented'},
        },
        required: ['summary'],
      },
    },
  },
]

type OAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{id: string; type: 'function'; function: {name: string; arguments: string}}>
  tool_call_id?: string
  name?: string
}

// ── AgenticApiPeer ──

export class AgenticApiPeer implements Peer {
  readonly mode = 'api' as const
  readonly role: 'conductor' | 'implementer'

  private logger: PeerLogger
  private orch: OrchManager

  constructor(
    private readonly config: PeerConfig,
    private readonly repoRoot: string,
    private readonly worktreePath: string,
    private readonly baseURL?: string   // e.g. https://api.moonshot.ai/v1
  ) {
    this.role = config.role
    this.logger = new PeerLogger(repoRoot, config.id)
    this.orch = new OrchManager(repoRoot)
  }

  get id(): string { return this.config.id }

  capabilities(): Capability[] {
    return ['read', 'write', 'bash', 'search', 'test']
  }

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const apiKey = (this.config.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY ?? '').trim()
    if (!apiKey) {
      yield {type: 'error', error: `No API key for ${this.config.id} peer`}
      return
    }

    this.logger.append({type: 'system', content: `send:${msg.type}`, taskId: msg.taskId})

    const {OpenAI} = await import('openai')
    const client = new OpenAI({
      apiKey,
      baseURL: this.baseURL ?? (this.config.apiKey ? undefined : 'https://api.openai.com/v1'),
    })

    const model = this.config.model ?? this.defaultModel()
    const systemPrompt = this.buildSystemPrompt()
    const userPrompt = this.buildUserPrompt(msg)

    // Fresh conversation per task (avoids context explosion across tasks)
    const messages: OAIMessage[] = [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: userPrompt},
    ]

    let totalCost = 0
    let turns = 0

    while (turns < MAX_TURNS) {
      turns++

      // Call the model
      let textContent = ''
      const toolCalls: Array<{id: string; name: string; args: string}> = []
      let inputTokens = 0
      let outputTokens = 0

      try {
        const stream = await client.chat.completions.create({
          model,
          messages: messages as never,
          tools: TOOLS,
          tool_choice: 'auto',
          max_tokens: 8192,
          stream: true,
        })

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta
          if (!delta) continue

          if (delta.content) {
            textContent += delta.content
            this.logger.append({type: 'text', content: delta.content, taskId: msg.taskId})
            yield {type: 'text', content: delta.content}
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCalls[idx]) {
                toolCalls[idx] = {id: tc.id ?? `tc_${idx}`, name: tc.function?.name ?? '', args: ''}
                if (tc.function?.name) {
                  yield {type: 'tool_use', toolName: tc.function.name, toolInput: {}}
                }
              }
              if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments
              if (tc.id) toolCalls[idx].id = tc.id
            }
          }

          // Track usage from final chunk
          const usage = (chunk as unknown as {usage?: {prompt_tokens: number; completion_tokens: number}}).usage
          if (usage) {
            inputTokens = usage.prompt_tokens
            outputTokens = usage.completion_tokens
          }
        }
      } catch (err) {
        const errMsg = String(err)
        this.logger.append({type: 'error', content: errMsg, taskId: msg.taskId})
        yield {type: 'error', error: errMsg}
        return
      }

      // Add assistant turn to history
      const assistantMsg: OAIMessage = {
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 ? {
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {name: tc.name, arguments: tc.args},
          })),
        } : {}),
      }
      messages.push(assistantMsg)

      // Accumulate cost
      const chunkCost = this.estimateCost(inputTokens, outputTokens)
      totalCost += chunkCost

      // No tool calls = model is done thinking, no more work to do
      if (toolCalls.length === 0) {
        this.logger.append({type: 'result', content: textContent, costUsd: totalCost, turns, taskId: msg.taskId})
        yield {type: 'result', content: textContent, costUsd: totalCost, turns}
        return
      }

      // Execute tools and feed results back
      let completed = false
      for (const tc of toolCalls) {
        if (!tc.name) continue

        const args = this.parseArgs(tc.args)
        this.logger.append({type: 'tool_use', toolName: tc.name, toolInput: args, taskId: msg.taskId})

        const result = await this.executeTool(tc.name, args)

        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
          name: tc.name,
        })

        if (tc.name === 'task_complete') {
          const summary = (args.summary as string) ?? textContent
          this.logger.append({type: 'result', content: summary, costUsd: totalCost, turns, taskId: msg.taskId})
          yield {type: 'result', content: summary, costUsd: totalCost, turns}
          completed = true
          break
        }
      }

      if (completed) return
    }

    // Max turns reached
    const summary = 'Max turns reached'
    this.logger.append({type: 'result', content: summary, costUsd: totalCost, turns: MAX_TURNS, taskId: msg.taskId})
    yield {type: 'result', content: summary, costUsd: totalCost, turns: MAX_TURNS}
  }

  // ── Tool execution ──

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case 'read_file': {
          const p = this.resolve(args.path as string)
          if (!fs.existsSync(p)) return `Error: file not found: ${args.path}`
          const content = fs.readFileSync(p, 'utf8')
          return content.length > MAX_OUTPUT
            ? content.slice(0, MAX_OUTPUT) + `\n... (truncated, ${content.length} chars total)`
            : content
        }

        case 'write_file': {
          const p = this.resolve(args.path as string)
          fs.mkdirSync(path.dirname(p), {recursive: true})
          fs.writeFileSync(p, args.content as string)
          return `Written: ${args.path}`
        }

        case 'edit_file': {
          const p = this.resolve(args.path as string)
          if (!fs.existsSync(p)) return `Error: file not found: ${args.path}`
          const original = fs.readFileSync(p, 'utf8')
          const oldStr = args.old_string as string
          if (!original.includes(oldStr)) {
            return `Error: old_string not found in ${args.path}. Use read_file first to verify the exact content.`
          }
          const updated = original.replace(oldStr, args.new_string as string)
          fs.writeFileSync(p, updated)
          return `Edited: ${args.path}`
        }

        case 'create_dir': {
          const p = this.resolve(args.path as string)
          fs.mkdirSync(p, {recursive: true})
          return `Created: ${args.path}`
        }

        case 'delete_file': {
          const p = this.resolve(args.path as string)
          if (!fs.existsSync(p)) return `Not found: ${args.path}`
          fs.unlinkSync(p)
          return `Deleted: ${args.path}`
        }

        case 'run_bash': {
          const cmd = (args.command as string).trim()
          if (BLOCKED_CMDS.test(cmd)) {
            return `Blocked by MetaCLiDE: deploy/destructive commands not allowed. Command: ${cmd}`
          }
          const {execa} = await import('execa')
          const result = await execa('bash', ['-c', cmd], {
            cwd: this.worktreePath,
            stdio: 'pipe',
            reject: false,
            timeout: 30_000,
          })
          const out = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
          const truncated = out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + '\n...(truncated)' : out
          return `Exit ${result.exitCode}:\n${truncated || '(no output)'}`
        }

        case 'search_files': {
          const {execa} = await import('execa')
          const pattern = args.pattern as string
          const dir = args.dir ? this.resolve(args.dir as string) : this.worktreePath
          const glob = args.glob as string | undefined

          const grepArgs = ['-r', '--include', glob ?? '*', '-n', '--max-count=3', '-E', pattern, dir]
          const result = await execa('grep', grepArgs, {
            cwd: this.worktreePath,
            stdio: 'pipe',
            reject: false,
            timeout: 10_000,
          })
          const out = result.stdout.trim()
          return out.length > MAX_SEARCH ? out.slice(0, MAX_SEARCH) + '\n...(truncated)' : (out || '(no matches)')
        }

        case 'list_dir': {
          const dir = args.path ? this.resolve(args.path as string) : this.worktreePath
          if (!fs.existsSync(dir)) return `Not found: ${args.path}`
          const entries = fs.readdirSync(dir, {withFileTypes: true})
          return entries
            .filter(e => !e.name.startsWith('.'))
            .map(e => `${e.isDirectory() ? 'dir' : 'file'}  ${e.name}`)
            .join('\n') || '(empty)'
        }

        case 'task_complete':
          return 'Task complete'

        default:
          return `Unknown tool: ${name}`
      }
    } catch (err) {
      return `Tool error (${name}): ${String(err)}`
    }
  }

  // ── Helpers ──

  private resolve(relPath: string): string {
    // Prevent path traversal outside the worktree
    const resolved = path.resolve(this.worktreePath, relPath)
    if (!resolved.startsWith(this.worktreePath)) {
      throw new Error(`Path outside worktree: ${relPath}`)
    }
    return resolved
  }

  private parseArgs(raw: string): Record<string, unknown> {
    try { return JSON.parse(raw) } catch { return {} }
  }

  private estimateCost(inputTokens: number, outputTokens: number): number {
    // Approximate pricing — overridden by config if known
    const inputRate = 0.0000015   // $1.50/M input (gpt-4o-mini scale default)
    const outputRate = 0.000006   // $6/M output
    return inputTokens * inputRate + outputTokens * outputRate
  }

  private defaultModel(): string {
    // Pick a sensible default per provider
    const provider = this.config.provider
    if (provider === 'moonshot') return 'kimi-k2-thinking-turbo'
    if (provider === 'openai') return 'gpt-4o-mini'
    return 'gpt-4o-mini'
  }

  private buildSystemPrompt(): string {
    return [
      `You are ${this.config.displayName} (id: ${this.id}), role: ${this.role} in a MetaCLiDE multi-agent coding session.`,
      `Your worktree is at: ${this.worktreePath}`,
      `Contracts (READ-ONLY): .orch/contracts/ — never modify them. File a CR to propose changes.`,
      '',
      'You have tools to read/write/edit files, run bash, and search. Use them to implement your task.',
      'After completing work, commit your changes with run_bash("git add -A && git commit -m \'...\'"), then call task_complete.',
      'Do NOT call task_complete before committing.',
      '',
      'Rules:',
      '- Never modify .orch/contracts/ directly',
      '- Work only within your worktree',
      '- If the contracts are insufficient, write .orch/change-requests/CR-<id>.json and call task_complete',
    ].join('\n')
  }

  private buildUserPrompt(msg: PeerMessage): string {
    const lines = [
      `[METACLIDE — ${msg.type.toUpperCase()} PHASE]`,
      '',
      msg.content,
    ]
    if (msg.attachments?.length) {
      lines.push('\n## Attached Files')
      for (const a of msg.attachments) lines.push(`\n### ${a.path}\n${a.content}`)
    }
    return lines.join('\n')
  }

  // ── Peer interface ──

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
}
