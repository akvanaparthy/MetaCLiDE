import type {Capability, PeerMessage, PeerEvent, PeerStatusUpdate} from '../../types.js'

export interface Peer {
  id: string
  mode: 'tool' | 'api'
  role: 'conductor' | 'implementer'

  capabilities(): Capability[]

  /** Send a message to the peer and stream back events */
  send(msg: PeerMessage): AsyncIterable<PeerEvent>

  ackContract(version: number, hash: string): Promise<void>

  writeStatus(update: PeerStatusUpdate): Promise<void>

  shutdown(): Promise<void>
}
