import {Command, Args} from '@oclif/core'
import {findRepoRoot} from '../lib/orch/index.js'
import {listSessions, loadMessages} from '../lib/tui-sessions/index.js'

export default class Sessions extends Command {
  static description = 'List and inspect past MetaCLiDE TUI sessions'

  static examples = [
    '<%= config.bin %> sessions',
    '<%= config.bin %> sessions <id>',
  ]

  static args = {
    id: Args.string({description: 'Session ID to inspect', required: false}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(Sessions)

    const repoRoot = findRepoRoot()
    if (!repoRoot) {
      this.error('Not inside a git repository.')
    }

    const sessions = listSessions(repoRoot)

    if (args.id) {
      // Show messages for a specific session
      const session = sessions.find(s => s.state.id.startsWith(args.id!))
      if (!session) {
        this.error(`Session not found: ${args.id}`)
      }
      const messages = loadMessages(repoRoot, session.state.id)
      this.log(`Session: ${session.state.id}`)
      this.log(`Title: ${session.state.title}`)
      this.log(`Conductor: ${session.state.conductorDisplayName}`)
      this.log(`Updated: ${session.state.updatedAt}`)
      this.log(`Messages: ${messages.length}`)
      this.log('')
      for (const msg of messages) {
        const prefix = msg.role === 'user' ? 'you' : msg.peerId ?? msg.role
        if (msg.content?.trim()) {
          this.log(`[${prefix}] ${msg.content.slice(0, 120)}`)
        }
      }
      return
    }

    if (sessions.length === 0) {
      this.log('No sessions found for this workspace.')
      this.log('Start one with `metaclide`')
      return
    }

    this.log('Past sessions (most recent first):\n')
    for (const {state} of sessions) {
      const ago = timeSince(state.updatedAt)
      this.log(`  ${state.id.slice(0, 8)}  ${state.title.padEnd(40)} ${state.conductorDisplayName}  ${ago}`)
    }
    this.log('')
    this.log('Resume with: metaclide --session <id>')
    this.log('Continue last: metaclide --continue')
  }
}

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
