import React from 'react'
import {Box, Text} from 'ink'

interface StatusBarProps {
  loading: boolean
  hint?: string
}

export function StatusBar({loading, hint}: StatusBarProps) {
  return (
    <Box marginTop={1}>
      {loading ? (
        <Text color="yellow">● Thinking...</Text>
      ) : (
        <Text dimColor>{hint ?? 'Type your message. /help for commands. /exit to quit.'}</Text>
      )}
    </Box>
  )
}
