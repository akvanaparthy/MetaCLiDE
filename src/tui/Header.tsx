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

const PHASE_COLORS: Record<string, string> = {
  discuss: 'cyan',
  planning: 'blue',
  plan: 'blue',
  contracts: 'magenta',
  lock: 'magenta',
  implement: 'yellow',
  implementation: 'yellow',
  integrate: 'green',
  integration: 'green',
  done: 'greenBright',
  starting: 'gray',
}

export function Header({conductorName, projectName, phase, model, contractVersion, peerCount}: HeaderProps) {
  const phaseColor = PHASE_COLORS[phase?.toLowerCase()] ?? 'yellow'

  // Build info segments
  const segments: React.ReactNode[] = []

  if (projectName) {
    segments.push(
      <Text key="proj">
        <Text dimColor>project </Text><Text bold>{projectName}</Text>
      </Text>
    )
  }
  if (conductorName) {
    segments.push(
      <Text key="cond">
        <Text dimColor>conductor </Text><Text color="green">{conductorName}</Text>
      </Text>
    )
  }
  if (model) {
    segments.push(
      <Text key="model">
        <Text dimColor>model </Text><Text color="magenta">{model}</Text>
      </Text>
    )
  }
  if (phase) {
    segments.push(
      <Text key="phase">
        <Text dimColor>phase </Text><Text bold color={phaseColor}>{phase}</Text>
      </Text>
    )
  }
  if (contractVersion !== undefined && contractVersion > 0) {
    segments.push(
      <Text key="cv">
        <Text dimColor>contract </Text><Text color="blue">v{contractVersion}</Text>
      </Text>
    )
  }
  if (peerCount !== undefined && peerCount > 0) {
    segments.push(
      <Text key="peers">
        <Text dimColor>peers </Text><Text>{peerCount}</Text>
      </Text>
    )
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{'─'.repeat(60)}</Text>
      <Box>
        <Text bold color="cyanBright">  MetaCLiDE</Text>
        <Text dimColor>  Multi-Agent Orchestration</Text>
      </Box>
      {segments.length > 0 && (
        <Box>
          <Text dimColor>  </Text>
          {segments.map((seg, i) => (
            <React.Fragment key={i}>
              {seg}
              {i < segments.length - 1 && <Text dimColor>  │  </Text>}
            </React.Fragment>
          ))}
        </Box>
      )}
      <Text dimColor>{'─'.repeat(60)}</Text>
    </Box>
  )
}
