// AgentManager TUI — /agents command
// Shows all agents with auth status + current model.
// Selecting an agent opens an official model picker for that provider.
import React, {useState} from 'react'
import {Box, Text, useInput} from 'ink'
import SelectInput from 'ink-select-input'

export interface AgentEntry {
  id: string
  displayName: string
  provider: 'anthropic' | 'openai' | 'moonshot' | string
  mode: 'oauth' | 'byok'
  authStatus: 'subscription' | 'apikey' | 'none'
  cliInstalled: boolean
  currentModel?: string
  role: 'conductor' | 'implementer'
  configured: boolean  // in peers.json
}

interface AgentManagerProps {
  agents: AgentEntry[]
  onModelChange: (agentId: string, model: string) => void
  onBack: () => void
}

// ── Official model lists per provider (March 2026) ──

export const PROVIDER_MODELS: Record<string, Array<{id: string; label: string; note: string; recommended?: boolean}>> = {
  anthropic: [
    {id: 'claude-opus-4-6',          label: 'Claude Opus 4.6',    note: 'Most capable — complex planning, architecture', recommended: false},
    {id: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6',  note: 'Balanced speed + capability', recommended: true},
    {id: 'claude-haiku-4-5-20251001',label: 'Claude Haiku 4.5',   note: 'Fast, lightweight — simple tasks'},
    {id: 'claude-opus-4-5',          label: 'Claude Opus 4.5',    note: 'Previous generation Opus'},
    {id: 'claude-sonnet-4-5',        label: 'Claude Sonnet 4.5',  note: 'Previous generation Sonnet'},
  ],
  openai: [
    {id: 'o4-mini',     label: 'o4-mini',     note: 'Fast reasoning, excellent for coding', recommended: true},
    {id: 'o3',          label: 'o3',           note: 'Advanced reasoning'},
    {id: 'o3-mini',     label: 'o3-mini',      note: 'Compact reasoning model'},
    {id: 'gpt-4o',      label: 'GPT-4o',       note: 'Multimodal, fast'},
    {id: 'gpt-4o-mini', label: 'GPT-4o mini',  note: 'Lightweight, cheap'},
  ],
  moonshot: [
    {id: 'kimi-k2-thinking-turbo', label: 'Kimi K2 Thinking Turbo', note: 'Complex reasoning (recommended)', recommended: true},
    {id: 'kimi-k2',                label: 'Kimi K2',                note: 'General coding tasks'},
    {id: 'kimi-k2-5',              label: 'Kimi K2.5',              note: 'Latest multimodal model'},
    {id: 'kimi-coding-k2.5',       label: 'Kimi Coding K2.5',       note: 'Specialized code generation'},
    {id: 'kimi-k2-instruct',       label: 'Kimi K2 Instruct',       note: 'Instruction-following variant'},
  ],
}

function authLabel(entry: AgentEntry): string {
  if (entry.authStatus === 'subscription') return '● subscription'
  if (entry.authStatus === 'apikey')       return '● API key'
  return '○ not connected'
}

function authColor(status: AgentEntry['authStatus']): string {
  if (status === 'subscription') return 'green'
  if (status === 'apikey')       return 'cyan'
  return 'red'
}

// ── Model picker for a single agent ──

function ModelPicker({agent, onSelect, onBack}: {
  agent: AgentEntry
  onSelect: (model: string) => void
  onBack: () => void
}) {
  const models = PROVIDER_MODELS[agent.provider] ?? []

  useInput((_, key) => {
    if (key.escape) onBack()
  })

  if (models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>No official models defined for provider "{agent.provider}".</Text>
        <Text dimColor>Set model manually: metaclide agents add {agent.id} --model &lt;model-id&gt;</Text>
        <Text dimColor>Press Esc to go back.</Text>
      </Box>
    )
  }

  const items = models.map(m => ({
    label: [
      m.recommended ? '★ ' : '  ',
      m.label.padEnd(28),
      m.note,
      agent.currentModel === m.id ? '  ← current' : '',
    ].join(''),
    value: m.id,
  }))

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Select model for </Text>
        <Text bold color="cyan">{agent.displayName}</Text>
        {agent.cliInstalled && agent.authStatus === 'subscription' && (
          <Text dimColor>  (CLI mode — uses subscription)</Text>
        )}
        {agent.authStatus !== 'subscription' && (
          <Text dimColor>  (API mode)</Text>
        )}
      </Box>
      <SelectInput
        items={items}
        onSelect={(item) => onSelect(item.value)}
        initialIndex={models.findIndex(m => m.id === agent.currentModel)}
      />
      <Box marginTop={1}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  )
}

// ── Main AgentManager ──

export function AgentManager({agents, onModelChange, onBack}: AgentManagerProps) {
  const [selected, setSelected] = useState<AgentEntry | null>(null)

  useInput((_, key) => {
    if (key.escape) {
      if (selected) setSelected(null)
      else onBack()
    }
  })

  if (selected) {
    return (
      <ModelPicker
        agent={selected}
        onSelect={(model) => {
          onModelChange(selected.id, model)
          setSelected(null)
        }}
        onBack={() => setSelected(null)}
      />
    )
  }

  const items = agents.map(a => {
    const tick = authColor(a.authStatus) === 'green' || authColor(a.authStatus) === 'cyan' ? '✓' : '✗'
    const modelStr = a.currentModel ?? '(default)'
    const roleTag = a.role === 'conductor' ? '[conductor]' : '[implementer]'
    const cliTag = a.cliInstalled ? 'CLI' : 'API'
    return {
      label: `${tick} ${a.displayName.padEnd(16)} ${modelStr.padEnd(30)} ${roleTag} ${cliTag}`,
      value: a.id,
    }
  })

  items.push({label: '← Back', value: '__back__'})

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">Agent Manager</Text>
        <Text dimColor>  — select an agent to change its model</Text>
      </Box>

      {/* Auth status legend */}
      <Box marginBottom={1} gap={3}>
        <Text><Text color="green">✓ subscription</Text></Text>
        <Text><Text color="cyan">✓ API key</Text></Text>
        <Text><Text dimColor>✗ not connected</Text></Text>
      </Box>

      {/* Agent list */}
      {agents.map(a => (
        <Box key={a.id} marginBottom={0}>
          <Text color={authColor(a.authStatus) as 'green' | 'cyan' | 'red'}>
            {authLabel(a).padEnd(20)}
          </Text>
          <Text bold color="white">{a.displayName.padEnd(16)}</Text>
          <Text dimColor>{(a.currentModel ?? 'default').padEnd(32)}</Text>
          <Text dimColor>{a.role}  {a.cliInstalled ? 'CLI' : 'API loop'}</Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text dimColor>Select to change model:</Text>
      </Box>
      <SelectInput
        items={items}
        onSelect={(item) => {
          if (item.value === '__back__') { onBack(); return }
          const agent = agents.find(a => a.id === item.value)
          if (agent) setSelected(agent)
        }}
      />
      <Box marginTop={1}>
        <Text dimColor>Esc to go back  •  Not listed? metaclide agents add &lt;id&gt;</Text>
      </Box>
    </Box>
  )
}
