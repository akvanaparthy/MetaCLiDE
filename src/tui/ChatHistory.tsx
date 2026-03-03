import React from 'react'
import {Box} from 'ink'
import {Message, type MessageData} from './Message.js'

interface ChatHistoryProps {
  messages: MessageData[]
}

export function ChatHistory({messages}: ChatHistoryProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map(msg => (
        <Message key={msg.id} message={msg} />
      ))}
    </Box>
  )
}
