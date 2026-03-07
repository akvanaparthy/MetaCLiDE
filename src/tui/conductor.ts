// Conductor chat backend — manages conversation with the selected AI provider
// Supports: Anthropic (Claude), OpenAI-compatible (Codex/Kimi — both BYOK and OAuth)

import {OrchManager} from '../lib/orch/index.js'
import fs from 'node:fs'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  content: string
  toolName?: string
  toolId?: string
}

export interface StreamEvent {
  type: 'text' | 'tool_start' | 'tool_done' | 'error' | 'done'
  content?: string
  toolName?: string
}

export interface ConductorConfig {
  provider: 'anthropic' | 'openai' | 'moonshot'
  mode: 'byok' | 'oauth'
  apiKey?: string
  repoRoot: string
  orch: OrchManager
}

const CONDUCTOR_SYSTEM = `You are the Conductor agent in MetaCLiDE — a multi-agent coding orchestration system.

IMPORTANT RULES:
1. When the user describes what they want to build, IMMEDIATELY call the save_brief tool. Do NOT ask for more details first. Save what they told you right away.
2. After saving the brief, confirm what you saved and ask if they want to refine anything.
3. Be concise. One short paragraph max per response.
4. Never ask the user to format their input in a specific way. Accept whatever they say naturally.
5. You can read the current brief and list project files for context.

You have these tools: save_brief (to save the project), read_brief (to read current brief), list_files (to see project files).
When in doubt, save the brief first, refine later.`

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'o4-mini',
  moonshot: 'kimi-k2-thinking-turbo',
}

const API_BASES: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  moonshot: 'https://api.moonshot.cn',
}

const modelsCache: Record<string, string[]> = {}

export async function fetchAvailableModels(provider: string, apiKey: string): Promise<string[]> {
  if (modelsCache[provider]?.length) return modelsCache[provider]

  try {
    const base = API_BASES[provider]
    if (!base) return []

    const headers: Record<string, string> = provider === 'anthropic'
      ? {'x-api-key': apiKey, 'anthropic-version': '2023-06-01'}
      : {'Authorization': `Bearer ${apiKey}`}

    const res = await fetch(`${base}/v1/models`, {headers})
    if (!res.ok) return []

    const data = await res.json() as {data?: Array<{id: string}>}
    const ids = (data.data ?? []).map(m => m.id).sort()

    modelsCache[provider] = ids
    return ids
  } catch {
    return []
  }
}

const TOOL_DEFS = [
  {
    name: 'save_brief',
    description: 'Save the project brief to .orch/brief.md. Call this when you understand the project goals, requirements, and tech stack.',
    parameters: {
      type: 'object',
      properties: {
        name: {type: 'string', description: 'Project name'},
        requirements: {type: 'string', description: 'What should be built — features, goals, acceptance criteria'},
        stack: {type: 'string', description: 'Tech stack. Empty string if user wants agents to decide.'},
      },
      required: ['name', 'requirements'],
    },
  },
  {
    name: 'read_brief',
    description: 'Read the current project brief from .orch/brief.md',
    parameters: {type: 'object', properties: {}},
  },
  {
    name: 'list_files',
    description: 'List files in the project root directory for context',
    parameters: {type: 'object', properties: {}},
  },
]

export class ConductorChat {
  private config: ConductorConfig
  private model: string
  private anthropicMessages: Array<{role: string; content: unknown}> = []
  private openaiMessages: Array<{role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string}> = []

  constructor(config: ConductorConfig) {
    this.config = config
    this.model = DEFAULT_MODELS[config.provider]
    if (config.provider !== 'anthropic') {
      this.openaiMessages.push({role: 'system', content: CONDUCTOR_SYSTEM})
    }
  }

  getModel(): string { return this.model }
  setModel(model: string) { this.model = model }
  getProvider(): string { return this.config.provider }
  getApiKey(): string | undefined { return this.config.apiKey }

  async *send(userMessage: string): AsyncGenerator<StreamEvent> {
    if (this.config.provider === 'anthropic') {
      yield* this.sendAnthropic(userMessage)
      return
    }

    // OAuth subscription mode: use CLI subprocess for chat (codex exec / kimi --print)
    if (!this.config.apiKey || this.config.apiKey === '__oauth_session__') {
      yield* this.sendViaCLI(userMessage)
      return
    }

    yield* this.sendOpenAI(userMessage)
  }

  // ── Anthropic ──

  private async *sendAnthropic(userMessage: string): AsyncGenerator<StreamEvent> {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({apiKey: this.config.apiKey})

    const tools = TOOL_DEFS.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Record<string, unknown>,
    }))

    this.anthropicMessages.push({role: 'user', content: userMessage})

    try {
      let response = await client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: CONDUCTOR_SYSTEM,
        tools: tools as never,
        messages: this.anthropicMessages as never,
        stream: true,
      })

      // Collect the full response while streaming
      let currentText = ''
      const contentBlocks: Array<{type: string; text?: string; id?: string; name?: string; input?: unknown}> = []
      let stopReason = ''

      for await (const event of response) {
        const e = event as unknown as Record<string, unknown>

        if (e.type === 'content_block_start') {
          const block = e.content_block as Record<string, unknown>
          if (block.type === 'text') {
            contentBlocks.push({type: 'text', text: ''})
          } else if (block.type === 'tool_use') {
            contentBlocks.push({type: 'tool_use', id: String(block.id), name: String(block.name), input: {}})
            yield {type: 'tool_start', toolName: String(block.name)}
          }
        } else if (e.type === 'content_block_delta') {
          const delta = e.delta as Record<string, unknown>
          if (delta.type === 'text_delta') {
            const text = String(delta.text ?? '')
            currentText += text
            const last = contentBlocks[contentBlocks.length - 1]
            if (last?.type === 'text') last.text = (last.text ?? '') + text
            yield {type: 'text', content: text}
          } else if (delta.type === 'input_json_delta') {
            // Accumulate tool input JSON
            const last = contentBlocks[contentBlocks.length - 1]
            if (last?.type === 'tool_use') {
              last.input = ((last.input as string) ?? '') + String(delta.partial_json ?? '')
            }
          }
        } else if (e.type === 'message_delta') {
          const delta = e.delta as Record<string, unknown>
          stopReason = String(delta.stop_reason ?? '')
        }
      }

      // Parse tool inputs that were accumulated as JSON strings
      for (const block of contentBlocks) {
        if (block.type === 'tool_use' && typeof block.input === 'string') {
          try { block.input = JSON.parse(block.input) } catch { block.input = {} }
        }
      }

      this.anthropicMessages.push({role: 'assistant', content: contentBlocks})

      // Handle tool use
      if (stopReason === 'tool_use') {
        const toolUses = contentBlocks.filter(b => b.type === 'tool_use')
        const toolResults = toolUses.map(tu => ({
          type: 'tool_result' as const,
          tool_use_id: tu.id!,
          content: this.executeTool(tu.name!, tu.input as Record<string, unknown>),
        }))

        for (const tu of toolUses) {
          yield {type: 'tool_done', toolName: tu.name, content: `Done: ${tu.name}`}
        }

        this.anthropicMessages.push({role: 'user', content: toolResults})

        // Continue with tool results (non-streaming for simplicity in tool loop)
        const followUp = await client.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: CONDUCTOR_SYSTEM,
          tools: tools as never,
          messages: this.anthropicMessages as never,
        })

        const followContent = followUp.content as Array<{type: string; text?: string; id?: string; name?: string; input?: unknown}>
        this.anthropicMessages.push({role: 'assistant', content: followContent})

        for (const block of followContent) {
          if (block.type === 'text') {
            yield {type: 'text', content: block.text ?? ''}
          }
        }
      }

      yield {type: 'done'}
    } catch (err) {
      yield {type: 'error', content: err instanceof Error ? err.message : String(err)}
    }
  }

  // ── OpenAI-compatible ──

  private async *sendOpenAI(userMessage: string): AsyncGenerator<StreamEvent> {
    const {OpenAI} = await import('openai')
    // Moonshot uses international endpoint; .cn as fallback
    const baseURL = this.config.provider === 'moonshot' ? 'https://api.moonshot.ai/v1' : undefined
    const client = new OpenAI({apiKey: this.config.apiKey, baseURL})
    const model = this.model

    const tools = TOOL_DEFS.map(t => ({type: 'function' as const, function: {name: t.name, description: t.description, parameters: t.parameters}}))

    this.openaiMessages.push({role: 'user', content: userMessage})

    try {
      // Use streaming for responsive output
      const stream = await client.chat.completions.create({
        model,
        max_tokens: 4096,
        messages: this.openaiMessages as never,
        tools,
        stream: true,
      })

      let content = ''
      const toolCalls: Array<{id: string; name: string; arguments: string}> = []
      let currentTool: {id: string; name: string; arguments: string} | null = null

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        if (delta.content) {
          content += delta.content
          yield {type: 'text', content: delta.content}
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = {id: tc.id ?? '', name: tc.function?.name ?? '', arguments: ''}
                if (tc.function?.name) yield {type: 'tool_start', toolName: tc.function.name}
              }
              if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments
              if (tc.id) toolCalls[tc.index].id = tc.id
            }
          }
        }
      }

      this.openaiMessages.push({role: 'assistant', content: content || null, tool_calls: toolCalls.length > 0 ? toolCalls.map(tc => ({id: tc.id, type: 'function', function: {name: tc.name, arguments: tc.arguments}})) : undefined} as never)

      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
          const result = this.executeTool(tc.name, args)
          yield {type: 'tool_done', toolName: tc.name, content: result}
          this.openaiMessages.push({role: 'tool', content: result, tool_call_id: tc.id} as never)
        }

        // Follow-up after tool calls
        const followStream = await client.chat.completions.create({
          model, max_tokens: 4096,
          messages: this.openaiMessages as never,
          tools, stream: true,
        })
        let followContent = ''
        for await (const chunk of followStream) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) { followContent += delta; yield {type: 'text', content: delta} }
        }
        this.openaiMessages.push({role: 'assistant', content: followContent})
      }

      yield {type: 'done'}
    } catch (err) {
      yield {type: 'error', content: err instanceof Error ? err.message : String(err)}
    }
  }

  // ── CLI subprocess (OAuth subscription mode) ──
  //
  // CLI agents (Codex, Kimi) have their OWN tool sets (file edit, bash, etc.)
  // and don't know about our conductor tools (save_brief, etc.). So we:
  // 1. Ask the LLM to just respond conversationally (no tool calls)
  // 2. Parse the response for brief content and save it ourselves
  // 3. Compute deltas for Codex (sends accumulated text, not deltas)

  private async *sendViaCLI(userMessage: string): AsyncGenerator<StreamEvent> {
    const {execa} = await import('execa')
    const isCodex = this.config.provider === 'openai'
    const cliName = isCodex ? 'codex' : 'kimi'

    // CLI-specific system prompt: no tool calls, just conversational output.
    // We extract brief content from the response ourselves.
    const cliSystem = `You are the Conductor agent in MetaCLiDE — a multi-agent coding orchestration system.

Your job is to understand what the user wants to build, then respond with a clear project brief.

RULES:
1. When the user describes what they want to build, respond with the project brief in this format:
   ---BRIEF---
   # ProjectName
   ## Requirements
   (what should be built)
   ## Tech Stack
   (technologies to use)
   ---END---
2. After the brief block, add a short confirmation message.
3. Be concise. Accept whatever the user says naturally.
4. If the user asks questions or wants to refine, respond normally.`

    const prompt = `${cliSystem}\n\n---\n\nUser: ${userMessage}`

    try {
      let args: string[]
      if (isCodex) {
        args = ['exec', prompt, '--json', '--full-auto', '--sandbox', 'workspace-write']
      } else {
        args = ['--print', '-y', '-p', prompt, '--work-dir', this.config.repoRoot, '--output-format', 'stream-json']
      }

      const proc = execa(cliName, args, {
        cwd: this.config.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        reject: false,
      })

      let buffer = ''
      let fullText = ''
      // For Codex: track accumulated text per item to compute deltas
      const itemText = new Map<string, string>()

      for await (const chunk of proc.iterable()) {
        buffer += String(chunk)
        // Codex emits JSON without newlines — split on }{ boundary
        const parts = buffer.split(/\}\s*\{/).map((s, i, arr) =>
          (i > 0 ? '{' : '') + s + (i < arr.length - 1 ? '}' : '')
        )
        buffer = parts.pop() ?? ''

        for (const fragment of parts) {
          if (!fragment.trim()) continue
          try {
            const event = JSON.parse(fragment) as Record<string, unknown>

            if (isCodex) {
              const type = event.type as string
              if (type === 'item.updated' || type === 'item.completed') {
                const item = event.item as Record<string, unknown> | undefined
                const itemId = String(event.item_id ?? item?.id ?? '')
                const itemType = String(event.item_type ?? item?.type ?? '')
                if (itemType === 'agent_message' || itemType === 'reasoning') {
                  const accumulated = String(event.content ?? item?.text ?? '')
                  const prev = itemText.get(itemId) ?? ''
                  const delta = accumulated.length > prev.length ? accumulated.slice(prev.length) : (prev.length === 0 ? accumulated : '')
                  if (delta) {
                    itemText.set(itemId, accumulated)
                    fullText += delta
                    yield {type: 'text', content: delta}
                  }
                }
              } else if (type === 'error' || type === 'turn.failed') {
                yield {type: 'error', content: String(event.message ?? event.error ?? 'Codex error')}
              }
            } else {
              // Kimi JSONL
              const msgType = event.type as string
              if (msgType === 'ContentPart' || msgType === 'content') {
                const c = event.content as Record<string, unknown> | undefined
                const text = String(c?.value ?? c?.text ?? event.value ?? event.text ?? '')
                if (text) { fullText += text; yield {type: 'text', content: text} }
              }
              if (event.role === 'assistant' && event.content) {
                const text = String(event.content)
                fullText += text
                yield {type: 'text', content: text}
              }
            }
          } catch {
            if (fragment.trim()) { fullText += fragment; yield {type: 'text', content: fragment} }
          }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as Record<string, unknown>
          if (isCodex) {
            const type = event.type as string
            if (type === 'item.updated' || type === 'item.completed') {
              const item = event.item as Record<string, unknown> | undefined
              const itemType = String(event.item_type ?? item?.type ?? '')
              if (itemType === 'agent_message' || itemType === 'reasoning') {
                const text = String(event.content ?? item?.text ?? '')
                if (text) { fullText += text; yield {type: 'text', content: text} }
              }
            }
          }
        } catch { /* skip */ }
      }

      await proc

      // Extract and save brief from the response
      const briefMatch = fullText.match(/---BRIEF---\s*([\s\S]*?)\s*---END---/)
      if (briefMatch) {
        const briefContent = briefMatch[1].trim()
        this.config.orch.writeBrief(briefContent)
        yield {type: 'tool_start', toolName: 'save_brief'}
        yield {type: 'tool_done', toolName: 'save_brief', content: 'Brief saved'}
      }

      yield {type: 'done'}
    } catch (err) {
      const installCmd = isCodex ? 'npm install -g @openai/codex' : 'pip install kimi-cli'
      yield {
        type: 'error',
        content: `${cliName} CLI not found. Install it: ${installCmd}`,
      }
    }
  }

  // ── Tool execution ──

  private executeTool(name: string, input: Record<string, unknown>): string {
    const orch = this.config.orch

    switch (name) {
      case 'save_brief': {
        const projName = String(input.name ?? 'Project')
        const requirements = String(input.requirements ?? '')
        const stack = String(input.stack ?? '')

        const lines = [`# ${projName}`, '']
        if (requirements) lines.push('## Requirements', '', requirements, '')
        if (stack) lines.push('## Tech Stack', '', stack, '')

        orch.writeBrief(lines.join('\n'))
        return `Brief saved for "${projName}"`
      }

      case 'read_brief':
        return orch.readBrief() || '(empty — no brief written yet)'

      case 'list_files': {
        try {
          const entries = fs.readdirSync(this.config.repoRoot)
            .filter(e => !e.startsWith('.'))
            .slice(0, 50)
          return entries.join('\n') || '(empty directory)'
        } catch {
          return '(could not list files)'
        }
      }

      default:
        return `Unknown tool: ${name}`
    }
  }
}
