import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {OrchManager} from '../src/lib/orch/index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaclide-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

describe('OrchManager', () => {
  it('init creates .orch directory structure', () => {
    const orch = new OrchManager(tmpDir)
    expect(orch.exists()).toBe(false)

    orch.init('TestProject')

    expect(orch.exists()).toBe(true)
    expect(fs.existsSync(orch.paths.contracts)).toBe(true)
    expect(fs.existsSync(orch.paths.status)).toBe(true)
    expect(fs.existsSync(orch.paths.changeRequests)).toBe(true)
    expect(fs.existsSync(orch.paths.threads)).toBe(true)
    expect(fs.existsSync(orch.paths.logs)).toBe(true)
    expect(fs.existsSync(orch.paths.worktrees)).toBe(true)
  })

  it('init creates brief.md with project name', () => {
    const orch = new OrchManager(tmpDir)
    orch.init('MyApp')

    const brief = orch.readBrief()
    expect(brief).toContain('# MyApp')
  })

  it('init creates VERSION file set to 0', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()

    expect(orch.readContractVersion()).toBe(0)
  })

  it('readProjectName returns empty for default placeholder', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()

    expect(orch.readProjectName()).toBe('')
  })

  it('readProjectName extracts name from brief', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()
    orch.writeBrief('# My Cool App\n\nSome description')

    expect(orch.readProjectName()).toBe('My Cool App')
  })

  it('bumpContractVersion increments', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()

    expect(orch.readContractVersion()).toBe(0)
    expect(orch.bumpContractVersion()).toBe(1)
    expect(orch.readContractVersion()).toBe(1)
    expect(orch.bumpContractVersion()).toBe(2)
  })

  it('readPeers returns null when no peers.json', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()

    expect(orch.readPeers()).toBeNull()
  })

  it('writePeers and readPeers round-trip', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()

    const peers = {
      conductor: 'codex',
      peers: [
        {
          id: 'codex',
          displayName: 'Codex CLI',
          type: 'tool' as const,
          provider: 'openai',
          mode: 'oauth' as const,
          contextFile: 'AGENTS.md',
          branch: 'agent/codex',
          role: 'conductor' as const,
        },
      ],
    }

    orch.writePeers(peers)
    const result = orch.readPeers()
    expect(result).not.toBeNull()
    expect(result!.conductor).toBe('codex')
    expect(result!.peers).toHaveLength(1)
    expect(result!.peers[0].id).toBe('codex')
  })

  it('writePlan and readPlan round-trip', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()

    const plan = {
      version: 1,
      project: 'TestApp',
      tasks: [
        {
          id: 'task-001',
          title: 'Build API',
          owner: 'codex',
          status: 'pending' as const,
          phase: 'implement',
          dependencies: [],
          acceptance: 'API returns 200',
        },
      ],
    }

    orch.writePlan(plan)
    const result = orch.readPlan()
    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(1)
    expect(result!.tasks[0].title).toBe('Build API')
  })

  it('peer status read/write', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()

    expect(orch.readPeerStatus('codex')).toBeNull()

    orch.writePeerStatus({
      peer: 'codex',
      contractVersion: 1,
      contractHash: 'abc12345',
      activeTasks: ['task-001'],
      blockedBy: null,
      lastCommit: 'abc',
      branch: 'agent/codex',
      lastGateResult: {},
      notes: 'working',
    })

    const status = orch.readPeerStatus('codex')
    expect(status).not.toBeNull()
    expect(status!.contractVersion).toBe(1)
    expect(status!.activeTasks).toEqual(['task-001'])
  })

  it('change requests CRUD', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()

    expect(orch.listChangeRequests()).toHaveLength(0)

    orch.writeChangeRequest({
      id: 'CR-001',
      from: 'kimi',
      what: 'Add pagination endpoint',
      why: 'List endpoint returns too many items',
      proposed_change: 'Add GET /api/users?page=N&limit=M',
      impact: ['api.openapi.yaml', 'types.ts'],
      status: 'pending',
      conductor_resolution: null,
      resolved_at: null,
    })

    const crs = orch.listChangeRequests()
    expect(crs).toHaveLength(1)
    expect(crs[0].from).toBe('kimi')

    const cr = orch.readChangeRequest('CR-001')
    expect(cr).not.toBeNull()
    expect(cr!.what).toBe('Add pagination endpoint')
  })

  it('updatePeerModel modifies model in peers.json', () => {
    const orch = new OrchManager(tmpDir)
    orch.init()

    orch.writePeers({
      conductor: 'codex',
      peers: [{
        id: 'codex', displayName: 'Codex', type: 'tool', provider: 'openai',
        mode: 'oauth', contextFile: 'AGENTS.md', branch: 'agent/codex', role: 'conductor',
      }],
    })

    orch.updatePeerModel('codex', 'gpt-4o')
    const peers = orch.readPeers()
    expect(peers!.peers[0].model).toBe('gpt-4o')
  })
})
