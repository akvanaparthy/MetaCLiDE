import React from 'react'
import {Box, Text} from 'ink'

interface HeaderProps {
  conductorName: string
  projectName: string
  phase: string
  model?: string
  contractVersion?: number
  peerCount?: number
}

export function Header({conductorName, projectName, phase, model, contractVersion, peerCount}: HeaderProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">MetaCLiDE</Text>
        <Text dimColor> — Multi-Agent Coding Orchestration</Text>
      </Box>
      <Box gap={2} flexWrap="wrap">
        {projectName && (
          <Text>
            <Text dimColor>project:</Text> <Text bold>{projectName}</Text>
          </Text>
        )}
        {conductorName && (
          <Text>
            <Text dimColor>conductor:</Text> <Text color="green">{conductorName}</Text>
          </Text>
        )}
        {model && (
          <Text>
            <Text dimColor>model:</Text> <Text color="magenta">{model}</Text>
          </Text>
        )}
        {phase && (
          <Text>
            <Text dimColor>phase:</Text> <Text color="yellow">{phase}</Text>
          </Text>
        )}
        {contractVersion !== undefined && contractVersion > 0 && (
          <Text>
            <Text dimColor>contract:</Text> <Text color="blue">v{contractVersion}</Text>
          </Text>
        )}
        {peerCount !== undefined && peerCount > 0 && (
          <Text>
            <Text dimColor>peers:</Text> <Text>{peerCount}</Text>
          </Text>
        )}
      </Box>
    </Box>
  )
}
