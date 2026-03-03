import {Command, Flags} from '@oclif/core'
import {findRepoRoot, OrchManager} from '../lib/orch/index.js'

export default class Interactive extends Command {
  static description = 'MetaCLiDE interactive session — chat with the Conductor agent'
  static hidden = true

  static flags = {
    help: Flags.boolean({char: 'h'}),
  }

  async run(): Promise<void> {
    const repoRoot = findRepoRoot()
    if (!repoRoot) {
      this.log('No git repository found. Run `git init` first.')
      return
    }

    const orch = new OrchManager(repoRoot)
    if (!orch.exists()) {
      orch.init()
    }

    // Dynamic import to avoid loading React at module level
    const {render} = await import('ink')
    const React = await import('react')
    const {App} = await import('../tui/App.js')

    const {waitUntilExit} = render(
      React.createElement(App, {
        repoRoot,
        orch,
        onExit: () => {},
      })
    )

    await waitUntilExit()
  }
}
