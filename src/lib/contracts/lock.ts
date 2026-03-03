import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {orchPaths} from '../orch/paths.js'

export class ContractLock {
  private paths: ReturnType<typeof orchPaths>

  constructor(private readonly repoRoot: string) {
    this.paths = orchPaths(repoRoot)
  }

  isLocked(): boolean {
    return fs.existsSync(this.paths.lock)
  }

  lock(conductorId: string, version: number): void {
    const hash = this.hashContracts()
    const content = JSON.stringify(
      {
        lockedBy: conductorId,
        version,
        hash,
        lockedAt: new Date().toISOString(),
      },
      null,
      2
    )
    fs.writeFileSync(this.paths.lock, content)
  }

  unlock(): void {
    if (fs.existsSync(this.paths.lock)) {
      fs.unlinkSync(this.paths.lock)
    }
  }

  readLock(): {lockedBy: string; version: number; hash: string; lockedAt: string} | null {
    if (!fs.existsSync(this.paths.lock)) return null
    try {
      return JSON.parse(fs.readFileSync(this.paths.lock, 'utf8'))
    } catch {
      return null
    }
  }

  hashContracts(): string {
    if (!fs.existsSync(this.paths.contracts)) return ''
    const hasher = crypto.createHash('sha256')
    const files = fs.readdirSync(this.paths.contracts).sort()
    for (const file of files) {
      const p = path.join(this.paths.contracts, file)
      if (fs.statSync(p).isFile()) {
        hasher.update(fs.readFileSync(p))
      }
    }
    return hasher.digest('hex').slice(0, 8)
  }

  validatePeerAck(peerId: string, version: number, hash: string): boolean {
    const lock = this.readLock()
    if (!lock) return false
    return lock.version === version && lock.hash === hash
  }
}
