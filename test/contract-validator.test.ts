import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {ContractValidator} from '../src/lib/contracts/validation.js'
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

describe('ContractValidator', () => {
  it('returns empty when no contracts exist', async () => {
    const v = new ContractValidator(tmpDir)
    const mismatches = await v.detectMismatches()
    expect(mismatches).toHaveLength(0)
  })

  it('detects schema mismatches between entities.schema.json and types.ts', async () => {
    const orch = new OrchManager(tmpDir)

    // Schema defines User with id, name, email
    fs.writeFileSync(orch.paths.contractEntities, JSON.stringify({
      $defs: {
        User: {
          type: 'object',
          properties: {
            id: {type: 'string'},
            name: {type: 'string'},
            email: {type: 'string'},
          },
        },
      },
    }))

    // types.ts defines User with id, name (missing email), plus extra 'age'
    fs.writeFileSync(orch.paths.contractTypes, `
interface User {
  id: string
  name: string
  age: number
}
`)

    const v = new ContractValidator(tmpDir)
    const mismatches = await v.detectMismatches()

    const descriptions = mismatches.map(m => m.description)
    expect(descriptions.some(d => d.includes("'email'") && d.includes('missing in interface'))).toBe(true)
    expect(descriptions.some(d => d.includes("'age'") && d.includes('missing in schema'))).toBe(true)
  })

  it('detects missing interface for schema entity', async () => {
    const orch = new OrchManager(tmpDir)

    fs.writeFileSync(orch.paths.contractEntities, JSON.stringify({
      $defs: {
        Post: {
          type: 'object',
          properties: {id: {type: 'string'}, title: {type: 'string'}},
        },
      },
    }))

    // Empty types.ts — no matching interface
    fs.writeFileSync(orch.paths.contractTypes, '// empty\n')

    const v = new ContractValidator(tmpDir)
    const mismatches = await v.detectMismatches()

    expect(mismatches.some(m => m.description.includes("'Post'") && m.description.includes('no matching'))).toBe(true)
  })

  it('writeIntegrationReport creates report file', () => {
    const v = new ContractValidator(tmpDir)
    v.writeIntegrationReport(
      {lint: 'pass', typecheck: 'pass', test: 'skip', build: 'pass'},
      [],
      0
    )

    const orch = new OrchManager(tmpDir)
    expect(fs.existsSync(orch.paths.integrationReport)).toBe(true)
    const content = fs.readFileSync(orch.paths.integrationReport, 'utf8')
    expect(content).toContain('Integration Report')
    expect(content).toContain('lint: pass')
    expect(content).toContain('None detected')
  })
})
