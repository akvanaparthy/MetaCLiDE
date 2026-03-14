import React from 'react'
import {Box, Text} from 'ink'
import Spinner from 'ink-spinner'

interface StatusBarProps {
  loading: boolean
  hint?: string
}

export function StatusBar({loading, hint}: StatusBarProps) {
  if (loading) {
    return (
      <Box marginTop={0}>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text dimColor> thinking...</Text>
      </Box>
    )
  }

  // Parse hint into structured segments
  const parts = hint ? hint.split(/\s{2,}/) : ['Type a message', '/help for commands', '/exit to quit']

  return (
    <Box marginTop={0}>
      <Text dimColor>
        {parts.join('  ·  ')}
      </Text>
    </Box>
  )
}
