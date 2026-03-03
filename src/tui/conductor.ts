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

export const AVAILABLE_MODELS: Record<string, string[]> = {
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-4-20250514',
  ],
  openai: [
    'o4-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'o3',
    'o3-mini',
  ],
  moonshot: [
    'kimi-k2-thinking-turbo',
    'moonshot-v1-8k',
    'moonshot-v1-32k',
    'moonshot-v1-128k',
  ],
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

  async *send(userMessage: string): AsyncGenerator<StreamEvent> {
    if (this.config.provider === 'anthropic') {
      yield* this.sendAnthropic(userMessage)
    } else {
      // OpenAI-compatible: both BYOK and OAuth use the SDK
      // OAuth mode gives us an sk-... key from the Codex subscription
      yield* this.sendOpenAI(userMessage)
    }
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
    // Moonshot BYOK uses their own endpoint; Kimi OAuth also uses moonshot API
    const baseURL = this.config.provider === 'moonshot' ? 'https://api.moonshot.cn/v1' : undefined
    const client = new OpenAI({apiKey: this.config.apiKey, baseURL})
    const model = this.model

    const tools = TOOL_DEFS.map(t => ({type: 'function' as const, function: {name: t.name, description: t.description, parameters: t.parameters}}))

    this.openaiMessages.push({role: 'user', content: userMessage})

    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 4096,
        messages: this.openaiMessages as never,
        tools,
      })

      const choice = response.choices[0]
      const msg = choice.message

      this.openaiMessages.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.tool_calls as unknown[] | undefined,
      })

      if (msg.content) {
        yield {type: 'text', content: msg.content}
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function
          yield {type: 'tool_start', toolName: fn.name}
          const args = JSON.parse(fn.arguments) as Record<string, unknown>
          const result = this.executeTool(fn.name, args)
          yield {type: 'tool_done', toolName: fn.name, content: result}
          this.openaiMessages.push({role: 'tool', content: result, tool_call_id: tc.id} as never)
        }

        // Follow-up
        const followUp = await client.chat.completions.create({
          model,
          max_tokens: 4096,
          messages: this.openaiMessages as never,
          tools,
        })

        const fMsg = followUp.choices[0].message
        this.openaiMessages.push({role: 'assistant', content: fMsg.content})
        if (fMsg.content) yield {type: 'text', content: fMsg.content}
      }

      yield {type: 'done'}
    } catch (err) {
      yield {type: 'error', content: err instanceof Error ? err.message : String(err)}
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
