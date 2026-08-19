// AgentManager TUI — /agents command
// Shows all agents with auth status + current model.
// Selecting an agent opens a model picker that fetches models dynamically from the provider API.
import React, {useState, useEffect} from 'react'
import {Box, Text, useInput} from 'ink'
import Spinner from 'ink-spinner'
import SelectInput from 'ink-select-input'
import {fetchAvailableModels, getLastFetchError} from './conductor.js'
import {getCredential} from '../lib/auth/keychain.js'

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

const KEYCHAIN_IDS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  moonshot: 'moonshot',
}

const ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
}

function ModelPicker({agent, onSelect, onBack}: {
  agent: AgentEntry
  onSelect: (model: string) => void
  onBack: () => void
}) {
  const [models, setModels] = useState<string[]>([])
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState('')

  useInput((_, key) => {
    if (key.escape) onBack()
  })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Resolve an API key for fetching models
      let apiKey = process.env[ENV_KEYS[agent.provider] ?? '']?.trim() ?? ''
      if (!apiKey) {
        const stored = await getCredential(KEYCHAIN_IDS[agent.provider] ?? agent.provider)
        apiKey = stored?.trim() ?? ''
      }

      if (!apiKey) {
        if (!cancelled) {
          setError(`No API key found for ${agent.provider}. Set ${ENV_KEYS[agent.provider] ?? 'API key'} env var or run: metaclide connect --agent ${agent.id}`)
          setFetching(false)
        }
        return
      }

      const fetched = await fetchAvailableModels(agent.provider, apiKey)
      if (!cancelled) {
        if (fetched.length > 0) {
          setModels(fetched)
        } else {
          setError(getLastFetchError() || `Could not fetch models from ${agent.provider} API.`)
        }
        setFetching(false)
      }
    })()
    return () => { cancelled = true }
  }, [agent.provider])

  if (fetching) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text> Fetching models from {agent.provider} API...</Text>
        </Box>
      </Box>
    )
  }

  if (error || models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="red">{error || `No models returned by ${agent.provider} API.`}</Text>
        <Text dimColor>Check your API key and network connection.</Text>
        <Text dimColor>Esc to go back.</Text>
      </Box>
    )
  }

  const items = models.map(m => ({
    key: m,
    label: m === agent.currentModel ? `${m}  ← current` : m,
    value: m,
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
      <Text dimColor>{models.length} models fetched from {agent.provider} API</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => onSelect(item.value)}
          initialIndex={Math.max(0, models.indexOf(agent.currentModel ?? ''))}
        />
      </Box>
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
      key: a.id,
      label: `${tick} ${a.displayName.padEnd(16)} ${modelStr.padEnd(30)} ${roleTag} ${cliTag}`,
      value: a.id,
    }
  })

  items.push({key: 'back', label: '← Back', value: '__back__'})

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">Agent Manager</Text>
        <Text dimColor>  — select an agent to configure its model</Text>
      </Box>

      {/* Agent summary table */}
      {agents.map(a => {
        const aColor = authColor(a.authStatus) as 'green' | 'cyan' | 'red'
        const configTag = a.configured ? '✓ configured' : '  not added'
        return (
          <Box key={a.id} marginBottom={0}>
            <Box width={3}>
              <Text color={aColor}>{a.authStatus !== 'none' ? '●' : '○'}</Text>
            </Box>
            <Box width={16}>
              <Text bold>{a.displayName}</Text>
            </Box>
            <Box width={30}>
              <Text color={a.currentModel ? 'white' : 'gray'}>{a.currentModel ?? '(no model set)'}</Text>
            </Box>
            <Box width={16}>
              <Text color={a.configured ? 'green' : 'gray'}>{configTag}</Text>
            </Box>
            <Text dimColor>{a.cliInstalled ? 'CLI' : 'API'}</Text>
          </Box>
        )
      })}

      <Box marginTop={1}>
        <Text dimColor>Select agent to set model (auto-adds to session):</Text>
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
        <Text dimColor>Esc to go back  ·  Selecting a model auto-configures the agent for /run</Text>
      </Box>
    </Box>
  )
}
