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

export function PeerStatusPanel({peers, phase}: Props) {
  if (peers.length === 0) return null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Box marginBottom={0}>
        <Text dimColor>Phase: </Text>
        <Text bold color="yellow">{phase.toUpperCase()}</Text>
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
    indicator = <Spinner type="dots" />
  } else if (peer.status === 'done') {
    indicator = <Text color="green">✓</Text>
  } else if (peer.status === 'error') {
    indicator = <Text color="red">✗</Text>
  } else if (peer.status === 'blocked') {
    indicator = <Text color="yellow">⏸</Text>
  } else {
    indicator = <Text dimColor>○</Text>
  }

  return (
    <Box>
      <Box width={2}>{indicator}</Box>
      <Text bold color={color}>{peer.displayName.slice(0, 12).padEnd(12)}</Text>
      <Text dimColor> {peer.detail.slice(0, 60)}</Text>
    </Box>
  )
}
