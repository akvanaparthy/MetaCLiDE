import React from 'react'
import {Box, Text} from 'ink'

interface HeaderProps {
  conductorName: string
  projectName: string
  phase: string
}

export function Header({conductorName, projectName, phase}: HeaderProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">MetaCLiDE</Text>
        <Text dimColor> — Multi-Agent Coding Orchestration</Text>
      </Box>
      <Box gap={2}>
        {projectName && (
          <Text>
            <Text dimColor>Project:</Text> <Text bold>{projectName}</Text>
          </Text>
        )}
        <Text>
          <Text dimColor>Conductor:</Text> <Text color="green">{conductorName}</Text>
        </Text>
        {phase && (
          <Text>
            <Text dimColor>Phase:</Text> <Text color="yellow">{phase}</Text>
          </Text>
        )}
      </Box>
    </Box>
  )
}
