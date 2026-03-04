import {Command, Flags} from '@oclif/core'
import {findRepoRoot, OrchManager} from '../lib/orch/index.js'
import {startRefreshManager} from '../lib/auth/refresh.js'
import {getLastSession, loadState} from '../lib/tui-sessions/index.js'

export default class Interactive extends Command {
  static description = 'MetaCLiDE interactive session — chat with the Conductor, then /run to start agents'

  static examples = [
    '<%= config.bin %>',
    '<%= config.bin %> --continue',
    '<%= config.bin %> --session <id>',
  ]

  static flags = {
    continue: Flags.boolean({
      char: 'c',
      description: 'Resume the most recent session for this workspace',
    }),
    session: Flags.string({
      char: 's',
      description: 'Resume a specific session by ID',
    }),
    help: Flags.boolean({char: 'h'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Interactive)

    const repoRoot = findRepoRoot()
    if (!repoRoot) {
      this.log('No git repository found. Run `git init` first.')
      return
    }

    const orch = new OrchManager(repoRoot)
    if (!orch.exists()) orch.init()

    // Start background token refresh
    const refreshMgr = startRefreshManager()

    // Determine resume session
    let resumeSessionId: string | undefined

    if (flags.session) {
      const state = loadState(repoRoot, flags.session)
      if (!state) {
        this.warn(`Session ${flags.session} not found.`)
      } else {
        resumeSessionId = flags.session
      }
    } else if (flags.continue) {
      const last = getLastSession(repoRoot)
      if (!last) {
        this.log('No previous session found. Starting fresh.')
      } else {
        resumeSessionId = last.state.id
      }
    }

    const {render} = await import('ink')
    const React = await import('react')
    const {App} = await import('../tui/App.js')

    const {waitUntilExit} = render(
      React.createElement(App, {
        repoRoot,
        orch,
        resumeSessionId,
        onExit: () => {
          refreshMgr.stop()
        },
      })
    )

    await waitUntilExit()
    refreshMgr.stop()
  }
}
