import React, {useState} from 'react'
import {Box, Text} from 'ink'
import TextInput from 'ink-text-input'

interface ApiKeyInputProps {
  envVar: string
  onSubmit: (key: string) => void
}

export function ApiKeyInput({envVar, onSubmit}: ApiKeyInputProps) {
  const [value, setValue] = useState('')

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>Enter your </Text>
        <Text bold color="yellow">{envVar}</Text>
      </Box>
      <Text dimColor>Stored securely in OS keychain or encrypted file</Text>
      <Box marginTop={1}>
        <Text color="cyan">❯ </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(val) => {
            if (val.trim()) onSubmit(val.trim())
          }}
          mask="*"
        />
      </Box>
    </Box>
  )
}
