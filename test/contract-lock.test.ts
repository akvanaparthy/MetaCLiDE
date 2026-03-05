import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {ContractLock} from '../src/lib/contracts/lock.js'
import {OrchManager} from '../src/lib/orch/index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaclide-test-'))
  const orch = new OrchManager(tmpDir)
  orch.init()
})

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

describe('ContractLock', () => {
  it('isLocked returns false initially', () => {
    const lock = new ContractLock(tmpDir)
    expect(lock.isLocked()).toBe(false)
  })

  it('lock creates LOCK.contracts', () => {
    const lock = new ContractLock(tmpDir)
    lock.lock('conductor-1', 1)

    expect(lock.isLocked()).toBe(true)
    const data = lock.readLock()
    expect(data).not.toBeNull()
    expect(data!.lockedBy).toBe('conductor-1')
    expect(data!.version).toBe(1)
  })

  it('unlock removes LOCK.contracts', () => {
    const lock = new ContractLock(tmpDir)
    lock.lock('conductor-1', 1)
    expect(lock.isLocked()).toBe(true)

    lock.unlock()
    expect(lock.isLocked()).toBe(false)
    expect(lock.readLock()).toBeNull()
  })

  it('hashContracts is deterministic', () => {
    const lock = new ContractLock(tmpDir)
    const orch = new OrchManager(tmpDir)

    // Write a contract file
    fs.writeFileSync(orch.paths.contractApi, 'openapi: 3.0.0\npaths: {}')

    const hash1 = lock.hashContracts()
    const hash2 = lock.hashContracts()
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(8)
  })

  it('hashContracts changes when contracts change', () => {
    const lock = new ContractLock(tmpDir)
    const orch = new OrchManager(tmpDir)

    fs.writeFileSync(orch.paths.contractApi, 'openapi: 3.0.0\npaths: {}')
    const hash1 = lock.hashContracts()

    fs.writeFileSync(orch.paths.contractApi, 'openapi: 3.0.0\npaths:\n  /users: {}')
    const hash2 = lock.hashContracts()

    expect(hash1).not.toBe(hash2)
  })

  it('validatePeerAck checks version and hash', () => {
    const lock = new ContractLock(tmpDir)
    lock.lock('conductor-1', 1)
    const data = lock.readLock()!

    expect(lock.validatePeerAck('peer-1', data.version, data.hash)).toBe(true)
    expect(lock.validatePeerAck('peer-1', 2, data.hash)).toBe(false)
    expect(lock.validatePeerAck('peer-1', data.version, 'wronghash')).toBe(false)
  })
})
