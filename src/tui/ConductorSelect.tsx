import React from 'react'
import {Box, Text} from 'ink'
import SelectInput from 'ink-select-input'
import {hasCodexSession} from '../lib/auth/oauth-codex.js'
import {hasKimiSession} from '../lib/auth/oauth-kimi.js'

export interface ConductorChoice {
  provider: 'anthropic' | 'openai' | 'moonshot'
  mode: 'byok' | 'oauth'
  displayName: string
}

interface ConductorSelectProps {
  onSelect: (choice: ConductorChoice) => void
}

export function ConductorSelect({onSelect}: ConductorSelectProps) {
  const codexActive = hasCodexSession()
  const kimiActive = hasKimiSession()

  const items: Array<{label: string; value: ConductorChoice}> = [
    {
      label: 'Claude Code (API key)',
      value: {provider: 'anthropic', mode: 'byok', displayName: 'Claude'},
    },
    {
      label: codexActive ? 'Codex (OAuth) ●' : 'Codex (OAuth login)',
      value: {provider: 'openai', mode: 'oauth', displayName: 'Codex'},
    },
    {
      label: 'Codex / OpenAI (API key)',
      value: {provider: 'openai', mode: 'byok', displayName: 'Codex'},
    },
    {
      label: kimiActive ? 'Kimi (OAuth) ●' : 'Kimi (OAuth login)',
      value: {provider: 'moonshot', mode: 'oauth', displayName: 'Kimi'},
    },
    {
      label: 'Kimi / Moonshot (API key)',
      value: {provider: 'moonshot', mode: 'byok', displayName: 'Kimi'},
    },
  ]

  return (
    <Box flexDirection="column">
      <Text bold>Choose your Conductor agent:</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => onSelect(item.value)}
        />
      </Box>
    </Box>
  )
}
