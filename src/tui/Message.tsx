import React from 'react'
import {Box, Text} from 'ink'

export interface MessageData {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolName?: string
  streaming?: boolean
}

interface MessageProps {
  message: MessageData
}

export function Message({message}: MessageProps) {
  if (message.role === 'user') {
    return (
      <Box marginBottom={1}>
        <Text bold color="blue">you&gt; </Text>
        <Text>{message.content}</Text>
      </Box>
    )
  }

  if (message.role === 'tool') {
    return (
      <Box marginBottom={0} marginLeft={2}>
        <Text dimColor>[{message.toolName}] {message.content}</Text>
      </Box>
    )
  }

  if (message.role === 'system') {
    return (
      <Box marginBottom={1}>
        <Text dimColor italic>{message.content}</Text>
      </Box>
    )
  }

  // Assistant message
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text wrap="wrap">{message.content}{message.streaming ? <Text color="cyan">_</Text> : ''}</Text>
    </Box>
  )
}
