import {Command, Flags} from '@oclif/core'
import {findRepoRoot, OrchManager} from '../lib/orch/index.js'

export default class Init extends Command {
  static description = 'Initialize a MetaCLiDE orchestration workspace in the current git repo'

  static examples = [
    '<%= config.bin %> init',
    '<%= config.bin %> init --force',
  ]

  static flags = {
    force: Flags.boolean({char: 'f', description: 'Overwrite existing .orch directory'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Init)

    const repoRoot = findRepoRoot()
    if (!repoRoot) {
      this.error('Not inside a git repository. Run `git init` first.')
    }

    const orch = new OrchManager(repoRoot)

    if (orch.exists() && !flags.force) {
      this.log('.orch/ already exists. Use --force to reinitialize.')
      return
    }

    orch.init()

    this.log('Initialized MetaCLiDE workspace.')
    this.log('')
    this.log('Run `metaclide` to start chatting with the Conductor agent.')
  }
}
