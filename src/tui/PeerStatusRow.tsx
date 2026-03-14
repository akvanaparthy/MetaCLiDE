import React from 'react'
import {Box, Text} from 'ink'
import Spinner from 'ink-spinner'

export interface PeerDisplayStatus {
  peerId: string
  displayName: string
  status: 'idle' | 'thinking' | 'working' | 'done' | 'error' | 'blocked'
  detail: string
  color: string
}

interface Props {
  peers: PeerDisplayStatus[]
  phase: string
}

const PHASE_COLORS: Record<string, string> = {
  discuss: 'cyan',
  planning: 'blue',
  plan: 'blue',
  implement: 'yellow',
  implementation: 'yellow',
  integrate: 'green',
  integration: 'green',
  done: 'greenBright',
  starting: 'gray',
}

export function PeerStatusPanel({peers, phase}: Props) {
  if (peers.length === 0) return null

  const phaseColor = PHASE_COLORS[phase?.toLowerCase()] ?? 'yellow'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Box marginBottom={0} gap={1}>
        <Text dimColor>Phase</Text>
        <Text bold color={phaseColor}>{phase.toUpperCase()}</Text>
        <Text dimColor>│</Text>
        <Text dimColor>{peers.length} agent{peers.length !== 1 ? 's' : ''}</Text>
      </Box>
      {peers.map(p => (
        <PeerRow key={p.peerId} peer={p} />
      ))}
    </Box>
  )
}

function PeerRow({peer}: {peer: PeerDisplayStatus}) {
  const color = peer.color as 'cyan' | 'green' | 'magenta' | 'yellow' | 'blue' | 'white' | 'red'

  let indicator: React.ReactNode
  if (peer.status === 'thinking' || peer.status === 'working') {
    indicator = <Text color={color}><Spinner type="dots" /></Text>
  } else if (peer.status === 'done') {
    indicator = <Text color="green">✓</Text>
  } else if (peer.status === 'error') {
    indicator = <Text color="red">✗</Text>
  } else if (peer.status === 'blocked') {
    indicator = <Text color="yellow">⏸</Text>
  } else {
    indicator = <Text dimColor>·</Text>
  }

  return (
    <Box>
      <Box width={2}>{indicator}</Box>
      <Box width={14}>
        <Text bold color={color}>{peer.displayName.slice(0, 13)}</Text>
      </Box>
      <Text dimColor>{peer.detail.slice(0, 55)}</Text>
    </Box>
  )
}
