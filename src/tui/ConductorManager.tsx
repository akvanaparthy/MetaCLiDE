// ConductorManager — /conductor command
// Two-step flow:
//   Step 1: Pick provider + auth mode (with live connection status)
//   Step 2: Pick model for that provider
import React, {useState} from 'react'
import {Box, Text, useInput} from 'ink'
import SelectInput from 'ink-select-input'
import {hasCodexOAuthSession, getCodexApiKey} from '../lib/auth/oauth-codex.js'
import {hasKimiSession, getKimiAccessToken} from '../lib/auth/oauth-kimi.js'
import {detectInstalledCLIs} from '../lib/auth/session.js'
import {PROVIDER_MODELS} from './AgentManager.js'
import type {ConductorChoice} from './ConductorSelect.js'

export interface ConductorSelection {
  choice: ConductorChoice
  model: string
  resolvedApiKey?: string  // undefined = use OAuth credential file
}

interface Props {
  currentProvider: string
  currentModel?: string
  onSelect: (selection: ConductorSelection) => void
  onBack: () => void
}

// ── Step 1: Provider + auth picker ──

interface ProviderOption {
  choice: ConductorChoice
  authStatus: 'subscription' | 'apikey' | 'none'
  cliInstalled: boolean
  defaultModel: string
  description: string
}

function buildProviderOptions(): ProviderOption[] {
  const clis = detectInstalledCLIs()
  const codexSub = hasCodexOAuthSession()
  const codexKey = !codexSub ? getCodexApiKey() : null
  const kimiSub = hasKimiSession()
  const kimiKey = !kimiSub ? getKimiAccessToken() : null

  return [
    // Claude — always BYOK (Anthropic ToS)
    {
      choice: {provider: 'anthropic', mode: 'byok', displayName: 'Claude Code'},
      authStatus: process.env.ANTHROPIC_API_KEY ? 'apikey' : 'none',
      cliInstalled: clis['claude'] ?? false,
      defaultModel: 'claude-sonnet-4-6',
      description: 'Anthropic Claude via API key — full chat + agentic coding',
    },

    // Codex subscription (ChatGPT Plus/Pro/Team)
    {
      choice: {provider: 'openai', mode: 'oauth', displayName: 'Codex (subscription)'},
      authStatus: codexSub ? 'subscription' : 'none',
      cliInstalled: clis['codex'] ?? false,
      defaultModel: 'o4-mini',
      description: codexSub
        ? 'Codex CLI via ChatGPT subscription — uses your paid quota'
        : 'Connect first: metaclide connect --agent codex --oauth',
    },

    // Codex BYOK (OpenAI API key)
    {
      choice: {provider: 'openai', mode: 'byok', displayName: 'Codex (API key)'},
      authStatus: codexKey ? 'apikey' : 'none',
      cliInstalled: clis['codex'] ?? false,
      defaultModel: 'o4-mini',
      description: 'OpenAI API key — usage-based billing',
    },

    // Kimi subscription
    {
      choice: {provider: 'moonshot', mode: 'oauth', displayName: 'Kimi Code (subscription)'},
      authStatus: kimiSub ? 'subscription' : 'none',
      cliInstalled: clis['kimi'] ?? false,
      defaultModel: 'kimi-k2-thinking-turbo',
      description: kimiSub
        ? 'Kimi Code CLI via Kimi subscription — uses your paid quota'
        : 'Connect first: metaclide connect --agent kimi --oauth',
    },

    // Kimi BYOK (Moonshot API key)
    {
      choice: {provider: 'moonshot', mode: 'byok', displayName: 'Kimi (API key)'},
      authStatus: kimiKey ? 'apikey' : 'none',
      cliInstalled: clis['kimi'] ?? false,
      defaultModel: 'kimi-k2-thinking-turbo',
      description: 'Moonshot API key — usage-based billing',
    },
  ]
}

function statusIcon(status: ProviderOption['authStatus']): string {
  if (status === 'subscription') return '●'
  if (status === 'apikey')       return '●'
  return '○'
}

function statusColor(status: ProviderOption['authStatus']): 'green' | 'cyan' | 'gray' {
  if (status === 'subscription') return 'green'
  if (status === 'apikey')       return 'cyan'
  return 'gray'
}

function statusLabel(status: ProviderOption['authStatus']): string {
  if (status === 'subscription') return 'subscription ✓'
  if (status === 'apikey')       return 'API key ✓'
  return 'not connected'
}

// ── Step 2: Model picker ──

function ModelStep({option, onSelect, onBack}: {
  option: ProviderOption
  onSelect: (model: string) => void
  onBack: () => void
}) {
  useInput((_, key) => { if (key.escape) onBack() })

  const models = PROVIDER_MODELS[option.choice.provider] ?? []

  if (models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No official models defined for this provider. Using default: {option.defaultModel}</Text>
        <Text dimColor>Press Esc to go back or Enter to confirm default.</Text>
      </Box>
    )
  }

  const items = [
    ...models.map(m => ({
      label: [
        m.recommended ? '★ ' : '  ',
        m.label.padEnd(30),
        m.note,
      ].join(''),
      value: m.id,
    })),
    {label: '← Back', value: '__back__'},
  ]

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Select model for </Text>
        <Text bold color="cyan">{option.choice.displayName}</Text>
        <Text dimColor>
          {'  '}
          {option.authStatus === 'subscription' ? 'subscription mode' : 'API key mode'}
          {option.cliInstalled ? ' • CLI installed' : ' • API loop'}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>★ = recommended</Text>
      </Box>
      <SelectInput
        items={items}
        onSelect={(item) => {
          if (item.value === '__back__') { onBack(); return }
          onSelect(item.value)
        }}
      />
      <Box marginTop={1}>
        <Text dimColor>Esc to go back</Text>
      </Box>
    </Box>
  )
}

// ── Main component ──

export function ConductorManager({currentProvider, currentModel, onSelect, onBack}: Props) {
  const [selectedOption, setSelectedOption] = useState<ProviderOption | null>(null)

  useInput((_, key) => {
    if (key.escape) {
      if (selectedOption) setSelectedOption(null)
      else onBack()
    }
  })

  if (selectedOption) {
    return (
      <ModelStep
        option={selectedOption}
        onSelect={(model) => {
          // Resolve API key for the selection
          let resolvedApiKey: string | undefined
          const opt = selectedOption
          if (opt.choice.mode === 'byok') {
            // For BYOK, the chat will need an actual key
            // It will be resolved by App.tsx from keychain/env
            resolvedApiKey = undefined
          } else {
            // OAuth subscription: signal sentinel so conductor knows not to use API directly
            resolvedApiKey = '__oauth_session__'
          }
          onSelect({choice: opt.choice, model, resolvedApiKey})
        }}
        onBack={() => setSelectedOption(null)}
      />
    )
  }

  const options = buildProviderOptions()

  const items = [
    ...options.map(opt => ({
      label: [
        `${statusIcon(opt.authStatus)} `,
        opt.choice.displayName.padEnd(28),
        statusLabel(opt.authStatus).padEnd(20),
        opt.defaultModel,
      ].join(''),
      value: opt.choice.displayName,
    })),
    {label: '← Back', value: '__back__'},
  ]

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Change Conductor</Text>
        <Text dimColor>{'  '}current: {currentProvider} — {currentModel ?? 'default'}</Text>
      </Box>

      {/* Status summary */}
      <Box marginBottom={1} gap={3}>
        <Box><Text color="green">● subscription</Text></Box>
        <Box><Text color="cyan">● API key</Text></Box>
        <Box><Text dimColor>○ not connected</Text></Box>
      </Box>

      {/* Option details */}
      {options.map(opt => (
        <Box key={opt.choice.displayName}>
          <Text color={statusColor(opt.authStatus)}>
            {statusIcon(opt.authStatus)}
          </Text>
          <Text> </Text>
          <Text bold={opt.choice.provider === currentProvider}>{opt.choice.displayName.padEnd(28)}</Text>
          <Text dimColor>{opt.defaultModel.padEnd(28)}</Text>
          <Text dimColor>{statusLabel(opt.authStatus)}</Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text dimColor>Select to configure:</Text>
      </Box>
      <SelectInput
        items={items}
        onSelect={(item) => {
          if (item.value === '__back__') { onBack(); return }
          const opt = options.find(o => o.choice.displayName === item.value)
          if (opt) setSelectedOption(opt)
        }}
      />
      <Box marginTop={1}>
        <Text dimColor>Esc to cancel  •  Not connected? Run: metaclide connect --agent &lt;id&gt; --oauth</Text>
      </Box>
    </Box>
  )
}
