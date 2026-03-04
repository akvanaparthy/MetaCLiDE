import React from 'react'
import {Box, Text} from 'ink'

export interface MessageData {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'agent'
  content: string
  toolName?: string
  streaming?: boolean
  peerId?: string    // set when role === 'agent'
  peerColor?: string // pre-assigned per peer
}

const PEER_COLORS = ['cyan', 'green', 'magenta', 'yellow', 'blue', 'white'] as const
type PeerColor = typeof PEER_COLORS[number]

export function peerColor(peerId: string, allPeerIds: string[]): PeerColor {
  const idx = allPeerIds.indexOf(peerId)
  return PEER_COLORS[idx % PEER_COLORS.length] ?? 'white'
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

  if (message.role === 'agent') {
    const color = (message.peerColor ?? 'white') as PeerColor
    return (
      <Box marginBottom={0}>
        <Text bold color={color}>[{message.peerId}] </Text>
        <Text wrap="wrap">{message.content}</Text>
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

  // Assistant (conductor chat)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text wrap="wrap">
        {message.content}
        {message.streaming ? <Text color="cyan">▋</Text> : ''}
      </Text>
    </Box>
  )
}
