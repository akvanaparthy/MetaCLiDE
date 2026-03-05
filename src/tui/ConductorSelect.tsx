import React from 'react'
import {Box, Text} from 'ink'
import SelectInput from 'ink-select-input'
import {hasCodexOAuthSession, getCodexApiKey} from '../lib/auth/oauth-codex.js'
import {hasKimiSession} from '../lib/auth/oauth-kimi.js'
import {detectInstalledCLIs} from '../lib/auth/session.js'

export interface ConductorChoice {
  provider: 'anthropic' | 'openai' | 'moonshot'
  mode: 'byok' | 'oauth'
  displayName: string
}

interface ConductorSelectProps {
  onSelect: (choice: ConductorChoice) => void
}

export function ConductorSelect({onSelect}: ConductorSelectProps) {
  const codexSubscription = hasCodexOAuthSession()
  const codexApiKey = !codexSubscription && !!getCodexApiKey()
  const kimiSubscription = hasKimiSession()
  const clis = detectInstalledCLIs()

  function dot(connected: boolean) { return connected ? '●' : '○' }
  function dotColor(connected: boolean) { return connected ? ' ✓' : '' }

  const items: Array<{label: string; value: ConductorChoice}> = [
    // ── Claude ──
    {
      label: `${dot(false)} Claude Code  (API key)  │ claude-sonnet-4-6  │ chat + agents`,
      value: {provider: 'anthropic', mode: 'byok', displayName: 'Claude'},
    },

    // ── Codex / OpenAI subscription ──
    {
      label: codexSubscription
        ? `● Codex  ✓ subscription  │ o4-mini  │ ${clis['codex'] ? 'CLI agent ready' : '⚠ codex CLI not installed'}`
        : `○ Codex  (ChatGPT Plus/Pro login)  │ o4-mini  │ ${clis['codex'] ? 'CLI available' : 'needs codex CLI'}`,
      value: {provider: 'openai', mode: 'oauth', displayName: 'Codex'},
    },

    // ── Codex BYOK ──
    {
      label: codexApiKey
        ? `● Codex / OpenAI  ✓ API key  │ o4-mini  │ ${clis['codex'] ? 'CLI agent' : 'agentic API'}`
        : `○ Codex / OpenAI  (API key)  │ o4-mini  │ ${clis['codex'] ? 'CLI agent' : 'agentic API'}`,
      value: {provider: 'openai', mode: 'byok', displayName: 'Codex'},
    },

    // ── Kimi subscription ──
    {
      label: kimiSubscription
        ? `● Kimi Code  ✓ subscription  │ kimi-k2-thinking-turbo  │ ${clis['kimi'] ? 'CLI agent ready' : '⚠ kimi CLI not installed'}`
        : `○ Kimi Code  (subscription login)  │ kimi-k2-thinking-turbo  │ ${clis['kimi'] ? 'CLI available' : 'needs kimi CLI'}`,
      value: {provider: 'moonshot', mode: 'oauth', displayName: 'Kimi'},
    },

    // ── Kimi BYOK ──
    {
      label: `○ Kimi / Moonshot  (API key)  │ kimi-k2-thinking-turbo  │ ${clis['kimi'] ? 'CLI agent' : 'agentic API'}`,
      value: {provider: 'moonshot', mode: 'byok', displayName: 'Kimi'},
    },
  ]

  return (
    <Box flexDirection="column">
      <Text bold>Choose your Conductor:</Text>
      <Box marginBottom={1}>
        <Text dimColor>● = connected  │ subscription = paid plan quota  │ API key = usage billing</Text>
      </Box>
      <SelectInput
        items={items}
        onSelect={(item) => onSelect(item.value)}
      />
      <Box marginTop={1}>
        <Text dimColor>After selecting: /agents to change models  •  /run to start all agents</Text>
      </Box>
    </Box>
  )
}
