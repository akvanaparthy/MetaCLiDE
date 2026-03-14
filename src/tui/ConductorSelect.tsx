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

  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY

  const items: Array<{key: string; label: string; value: ConductorChoice}> = [
    {
      key: 'claude-byok',
      label: `${hasAnthropicKey ? '●' : '○'}  Claude Code${hasAnthropicKey ? ' ✓' : ''}  │  API key  │  claude-sonnet-4-6`,
      value: {provider: 'anthropic', mode: 'byok', displayName: 'Claude'},
    },
    {
      key: 'codex-oauth',
      label: codexSubscription
        ? `●  Codex ✓  │  subscription  │  ${clis['codex'] ? 'CLI ready' : '⚠ needs codex CLI'}`
        : `○  Codex  │  ChatGPT Plus/Pro login  │  ${clis['codex'] ? 'CLI available' : 'needs codex CLI'}`,
      value: {provider: 'openai', mode: 'oauth', displayName: 'Codex'},
    },
    {
      key: 'codex-byok',
      label: codexApiKey
        ? `●  Codex / OpenAI ✓  │  API key  │  ${clis['codex'] ? 'CLI agent' : 'agentic API'}`
        : `○  Codex / OpenAI  │  API key  │  ${clis['codex'] ? 'CLI agent' : 'agentic API'}`,
      value: {provider: 'openai', mode: 'byok', displayName: 'Codex'},
    },
    {
      key: 'kimi-oauth',
      label: kimiSubscription
        ? `●  Kimi Code ✓  │  subscription  │  ${clis['kimi'] ? 'CLI ready' : '⚠ needs kimi CLI'}`
        : `○  Kimi Code  │  subscription login  │  ${clis['kimi'] ? 'CLI available' : 'needs kimi CLI'}`,
      value: {provider: 'moonshot', mode: 'oauth', displayName: 'Kimi'},
    },
    {
      key: 'kimi-byok',
      label: `○  Kimi / Moonshot  │  API key  │  ${clis['kimi'] ? 'CLI agent' : 'agentic API'}`,
      value: {provider: 'moonshot', mode: 'byok', displayName: 'Kimi'},
    },
  ]

  return (
    <Box flexDirection="column">
      <Text bold color="white">Choose your conductor</Text>
      <Box marginBottom={1}>
        <Text dimColor>● connected  │  ○ not connected  │  ↑↓ navigate  │  enter select</Text>
      </Box>
      <SelectInput
        items={items}
        onSelect={(item) => onSelect(item.value)}
      />
      <Box marginTop={1}>
        <Text dimColor>/agents to manage models  ·  /run to start agents</Text>
      </Box>
    </Box>
  )
}
