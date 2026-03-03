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
      <Text>Enter your <Text bold color="yellow">{envVar}</Text>:</Text>
      <Box marginTop={1}>
        <Text color="cyan">&gt; </Text>
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
