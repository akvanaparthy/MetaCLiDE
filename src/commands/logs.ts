import {Command, Flags, Args} from '@oclif/core'
import {requireOrch} from '../lib/orch/index.js'
import {PeerLogger} from '../lib/logger/index.js'
import fs from 'node:fs'

export default class Logs extends Command {
  static description = 'View structured peer transcripts'

  static examples = [
    '<%= config.bin %> logs',
    '<%= config.bin %> logs --agent claude',
    '<%= config.bin %> logs --agent claude --tail 50',
    '<%= config.bin %> logs --follow',
  ]

  static flags = {
    agent: Flags.string({char: 'a', description: 'Filter by agent id'}),
    tail: Flags.integer({char: 'n', description: 'Show last N entries', default: 20}),
    follow: Flags.boolean({char: 'f', description: 'Follow log output (tail -f style)'}),
    json: Flags.boolean({description: 'Raw JSON output'}),
    type: Flags.string({description: 'Filter by event type (text, tool_use, result, error)'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Logs)
    const {orch, root} = requireOrch()

    const peers = orch.readPeers()
    const peerIds: string[] = flags.agent
      ? [flags.agent]
      : (peers?.peers.map(p => p.id) ?? [])

    if (peerIds.length === 0) {
      this.log('No peers configured. Run `metaclide agents add` first.')
      return
    }

    for (const peerId of peerIds) {
      const logger = new PeerLogger(root, peerId)
      const entries = logger.tail(flags.tail)

      const filtered = flags.type ? entries.filter(e => e.type === flags.type) : entries

      if (filtered.length === 0) {
        this.log(`[${peerId}] No log entries yet.`)
        continue
      }

      if (!flags.agent) {
        this.log(`\n=== ${peerId} ===`)
      }

      for (const entry of filtered) {
        if (flags.json) {
          this.log(JSON.stringify(entry))
        } else {
          const ts = new Date(entry.timestamp).toLocaleTimeString()
          const prefix = `[${ts}][${entry.type}]`
          if (entry.type === 'text') {
            this.log(`${prefix} ${(entry.content ?? '').slice(0, 120)}`)
          } else if (entry.type === 'tool_use') {
            this.log(`${prefix} ${entry.toolName}`)
          } else if (entry.type === 'result') {
            this.log(`${prefix} Done — ${entry.turns} turns, $${(entry.costUsd ?? 0).toFixed(4)}`)
          } else if (entry.type === 'error') {
            this.log(`${prefix} ERROR: ${entry.content}`)
          } else if (entry.type === 'system') {
            this.log(`${prefix} ${entry.content}`)
          } else {
            this.log(`${prefix} ${JSON.stringify(entry).slice(0, 120)}`)
          }
        }
      }
    }

    if (flags.follow) {
      this.log('\nFollowing logs (Ctrl+C to stop)...')
      await this.followLogs(root, peerIds, flags.json ?? false)
    }
  }

  private async followLogs(root: string, peerIds: string[], json: boolean): Promise<void> {
    const offsets: Record<string, number> = {}
    for (const id of peerIds) {
      const logger = new PeerLogger(root, id)
      offsets[id] = logger.read().length
    }

    await new Promise<void>(resolve => {
      const interval = setInterval(() => {
        for (const id of peerIds) {
          const logger = new PeerLogger(root, id)
          const entries = logger.read()
          const newEntries = entries.slice(offsets[id])
          if (newEntries.length > 0) {
            offsets[id] = entries.length
            for (const e of newEntries) {
              if (json) {
                this.log(JSON.stringify(e))
              } else {
                const ts = new Date(e.timestamp).toLocaleTimeString()
                this.log(`[${id}][${ts}][${e.type}] ${e.content ?? ''}`)
              }
            }
          }
        }
      }, 500)

      const cleanup = () => {
        clearInterval(interval)
        process.removeListener('SIGINT', cleanup)
        resolve()
      }
      process.on('SIGINT', () => {
        cleanup()
      })
    })
  }
}
