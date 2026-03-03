import {Command, Args, Flags} from '@oclif/core'
import {requireOrch} from '../../lib/orch/index.js'
import {deleteCredential} from '../../lib/auth/keychain.js'

export default class AgentsRemove extends Command {
  static description = 'Remove an agent from the active peer session'

  static examples = [
    '<%= config.bin %> agents remove kimi',
    '<%= config.bin %> agents remove codex --keep-key',
  ]

  static args = {
    id: Args.string({description: 'Agent id to remove', required: true}),
  }

  static flags = {
    'keep-key': Flags.boolean({description: 'Keep stored API key (do not delete from keychain)'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(AgentsRemove)
    const {orch} = requireOrch()

    const peers = orch.readPeers()
    if (!peers) {
      this.error('No peers configured. Run `metaclide agents add` first.')
    }

    const idx = peers.peers.findIndex(p => p.id === args.id)
    if (idx === -1) {
      this.error(`Agent "${args.id}" not found in peer list.`)
    }

    peers.peers.splice(idx, 1)

    // If removed agent was conductor, pick first remaining as conductor
    if (peers.conductor === args.id) {
      peers.conductor = peers.peers.find(p => p.role === 'conductor')?.id ?? peers.peers[0]?.id ?? ''
    }

    orch.writePeers(peers)

    if (!flags['keep-key']) {
      await deleteCredential(args.id)
      this.log(`Removed ${args.id} from peers and deleted stored credential.`)
    } else {
      this.log(`Removed ${args.id} from peers (key kept in keychain).`)
    }
  }
}
