import React from 'react'
import {Box, Text} from 'ink'

export interface SlashCommand {
  name: string
  description: string
}

const COMMANDS: SlashCommand[] = [
  {name: '/run',       description: 'Start multi-agent coding session'},
  {name: '/agents',    description: 'View/change agent models'},
  {name: '/conductor', description: 'Switch conductor provider/model'},
  {name: '/status',    description: 'Show phase, tasks, peer statuses'},
  {name: '/sessions',  description: 'List and resume past sessions'},
  {name: '/compact',   description: 'Compress conversation context'},
  {name: '/new',       description: 'Start fresh session'},
  {name: '/help',      description: 'Show all commands'},
  {name: '/exit',      description: 'Quit MetaCLiDE'},
]

interface SlashMenuProps {
  filter: string          // current input after '/'
  selectedIndex: number
}

export function getFilteredCommands(filter: string): SlashCommand[] {
  if (!filter) return COMMANDS
  const lower = filter.toLowerCase()
  return COMMANDS.filter(c => c.name.slice(1).startsWith(lower))
}

export function SlashMenu({filter, selectedIndex}: SlashMenuProps) {
  const filtered = getFilteredCommands(filter)
  if (filtered.length === 0) return null

  return (
    <Box flexDirection="column" marginBottom={0} borderStyle="single" borderColor="gray" paddingX={1}>
      {filtered.map((cmd, i) => {
        const isSelected = i === selectedIndex
        return (
          <Box key={cmd.name}>
            <Text
              bold={isSelected}
              color={isSelected ? 'cyanBright' : undefined}
              dimColor={!isSelected}
            >
              {isSelected ? '❯ ' : '  '}
              {cmd.name.padEnd(14)}
            </Text>
            <Text dimColor>{cmd.description}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
