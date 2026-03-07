// OrchestrationRunner — 6-phase pipeline as an async-generator event stream.
// Used by both `metaclide run` (CLI) and the TUI orchestrating phase.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {OrchManager} from './index.js'
import {ContractLock} from '../contracts/lock.js'
import {ContractValidator} from '../contracts/validation.js'
import {VerificationGates} from '../gates/index.js'
import {PeerFactory} from '../peers/factory.js'
import {WorktreeManager} from '../git/worktree.js'
import {SessionLogger} from '../logger/index.js'
import {Router} from '../router/index.js'
import type {PeerConfig, Task, PlanFile, GateResult, GateResults, ChangeRequest, BudgetConfig} from '../../types.js'
import type {Peer} from '../peers/interface.js'
import type {PeerEvent} from '../../types.js'

// ── Event types emitted to callers ──

export type OrchEvent =
  | {type: 'phase'; phase: string; message: string}
  | {type: 'log'; level?: 'info' | 'warn' | 'error'; message: string}
  | {type: 'peer_event'; peerId: string; displayName: string; peerEvent: PeerEvent}
  | {type: 'peer_phase'; peerId: string; status: string}
  | {type: 'contract_locked'; version: number; hash: string}
  | {type: 'gate_result'; gate: string; result: GateResult; output?: string}
  | {type: 'cr_detected'; cr: ChangeRequest}
  | {type: 'fix_iteration'; n: number; max: number}
  | {type: 'complete'}
  | {type: 'error'; message: string}

export interface RunnerOptions {
  repoRoot: string
  selectedPeers: PeerConfig[]
  conductorId: string
  skipPlanning?: boolean
  skipReview?: boolean
  stack?: string
  budget?: BudgetConfig
}

const MAX_FIX = 5

// Plan schema for structured output via codex exec --output-schema
const PLAN_SCHEMA = {
  type: 'object' as const,
  properties: {
    version: {type: 'integer' as const},
    project: {type: 'string' as const},
    tasks: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          id: {type: 'string' as const},
          title: {type: 'string' as const},
          owner: {type: 'string' as const},
          acceptance: {type: 'string' as const},
          dependencies: {type: 'array' as const, items: {type: 'string' as const}},
        },
        required: ['id', 'title', 'owner', 'acceptance', 'dependencies'] as const,
        additionalProperties: false,
      },
    },
  },
  required: ['version', 'project', 'tasks'] as const,
  additionalProperties: false,
}

async function generatePlan(
  conductor: PeerConfig,
  implementers: PeerConfig[],
  brief: string,
  stack: string | undefined,
  peerInput: string,
  repoRoot: string,
): Promise<{plan?: PlanFile; costUsd?: number; error?: string}> {
  const {execa} = await import('execa')
  const schemaPath = path.join(os.tmpdir(), `metaclide-plan-schema-${Date.now()}.json`)
  const outputPath = path.join(os.tmpdir(), `metaclide-plan-output-${Date.now()}.json`)

  try {
    fs.writeFileSync(schemaPath, JSON.stringify(PLAN_SCHEMA))

    const peerIds = implementers.map(p => p.id)
    const prompt = `IGNORE all files in the working directory. Plan ONLY for this project brief:

${brief.slice(0, 2000)}

Stack: ${stack ?? 'Determine from brief'}
Discussion: ${peerInput.slice(0, 1000) || '(none)'}

CRITICAL: The "owner" field MUST be one of these exact strings: ${peerIds.map(id => `"${id}"`).join(', ')}
Do NOT use any other owner values. Distribute tasks among these peer IDs.
Create 2-6 focused tasks for the project described in the brief above.`

    const args = ['exec', '--json', '--full-auto', '--sandbox', 'workspace-write',
      '--output-schema', schemaPath, '-o', outputPath, prompt]

    const result = await execa('codex', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
      timeout: 120_000,
    })

    // Parse cost from NDJSON output
    let costUsd = 0
    const stdout = result.stdout ?? ''
    for (const line of stdout.split(/\}\s*\{/).map((s, i, a) => (i > 0 ? '{' : '') + s + (i < a.length - 1 ? '}' : ''))) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>
        if (ev.type === 'turn.completed') {
          const usage = ev.usage as {input_tokens?: number; output_tokens?: number} | undefined
          if (usage) costUsd = ((usage.input_tokens ?? 0) * 0.000003) + ((usage.output_tokens ?? 0) * 0.000015)
        }
      } catch { /* skip */ }
    }

    if (!fs.existsSync(outputPath)) {
      return {error: 'No output file produced', costUsd}
    }

    const raw = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>
    const tasks: Task[] = (Array.isArray(raw.tasks) ? raw.tasks : []).map((t: Record<string, unknown>, idx: number) => {
      // Normalize owner: if not a valid peer ID, round-robin assign
      let owner = String(t.owner ?? '')
      if (!peerIds.includes(owner)) {
        owner = peerIds[idx % peerIds.length]
      }
      return {
        id: String(t.id ?? `task-${Math.random().toString(36).slice(2, 6)}`),
        title: String(t.title ?? ''),
        owner,
        status: 'pending' as const,
        phase: 'implement',
        dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
        acceptance: String(t.acceptance ?? ''),
      }
    })

    return {
      plan: {version: Number(raw.version ?? 1), project: String(raw.project ?? 'project'), tasks},
      costUsd,
    }
  } catch (err) {
    return {error: String(err)}
  } finally {
    try { fs.unlinkSync(schemaPath) } catch { /* ok */ }
    try { fs.unlinkSync(outputPath) } catch { /* ok */ }
  }
}

// ── Fan-in: merge N async iterables into one, preserving concurrency ──
async function* fanIn<T>(iters: AsyncIterable<T>[]): AsyncIterable<T> {
  if (iters.length === 0) return
  const queue: Array<{value: T} | {done: true}> = []
  let notify: (() => void) | null = null
  let running = iters.length

  function push(item: {value: T} | {done: true}) {
    queue.push(item)
    notify?.()
    notify = null
  }

  for (const iter of iters) {
    ;(async () => {
      try {
        for await (const v of iter) push({value: v})
      } finally {
        push({done: true})
      }
    })()
  }

  while (running > 0) {
    while (queue.length > 0) {
      const item = queue.shift()!
      if ('done' in item) { running--; continue }
      yield item.value
    }
    if (running > 0) await new Promise<void>(r => { notify = r })
  }
}

// ── Peer-scoped event generator helpers ──

async function* peerDiscuss(
  peer: Peer,
  cfg: PeerConfig,
  conductor: PeerConfig,
  brief: string
): AsyncIterable<OrchEvent> {
  const prompt = `You are starting a collaborative coding session.

Project brief:
${brief}

Team: Conductor is ${conductor.displayName}. You are ${cfg.displayName} (${cfg.role}).

Respond in 3-5 sentences:
1. Your understanding of what needs to be built
2. What aspects you're best suited to implement
3. Any upfront concerns

Be concise. This informs the Conductor's planning.`

  yield {type: 'peer_phase', peerId: cfg.id, status: 'discussing'} satisfies OrchEvent
  for await (const e of peer.send({type: 'discuss', content: prompt})) {
    yield {type: 'peer_event', peerId: cfg.id, displayName: cfg.displayName, peerEvent: e} satisfies OrchEvent
  }
}

async function* peerReview(
  peer: Peer,
  cfg: PeerConfig,
  contractContent: string,
  version: number,
  hash: string,
  orch: OrchManager
): AsyncIterable<OrchEvent> {
  const prompt = `Review the contracts below and respond with:
- "ACK" — you accept all contracts and can implement your tasks
- "REJECT <specific issue>" — you need a change

## Contracts
${contractContent}

Respond concisely.`

  yield {type: 'peer_phase', peerId: cfg.id, status: 'reviewing'} satisfies OrchEvent
  let lastText = ''
  for await (const e of peer.send({type: 'review', content: prompt})) {
    if (e.type === 'text') lastText += e.content ?? ''
    if (e.type === 'result') lastText = e.content ?? lastText
    yield {type: 'peer_event', peerId: cfg.id, displayName: cfg.displayName, peerEvent: e} satisfies OrchEvent
  }

  const acked = lastText.includes('ACK')
  if (acked) {
    await peer.ackContract(version, hash)
    yield {type: 'log', message: `  ${cfg.displayName}: ACK ✓`} satisfies OrchEvent
  } else {
    yield {type: 'log', level: 'warn', message: `  ${cfg.displayName}: REJECT — ${lastText.slice(0, 120)}`} satisfies OrchEvent
  }
}

async function* peerImplement(
  peer: Peer,
  cfg: PeerConfig,
  tasks: Task[],
  contractContent: string,
  worktreePath: string,
  wm: WorktreeManager
): AsyncIterable<OrchEvent> {
  if (tasks.length === 0) {
    yield {type: 'peer_phase', peerId: cfg.id, status: 'idle (no tasks)'} satisfies OrchEvent
    return
  }

  yield {type: 'peer_phase', peerId: cfg.id, status: `implementing ${tasks.length} task(s)`} satisfies OrchEvent

  await peer.writeStatus({
    activeTasks: tasks.map(t => t.id),
    blockedBy: null, lastCommit: '',
    lastGateResult: {}, notes: 'Starting implementation',
  })

  const taskList = tasks.map(t => `- [${t.id}] ${t.title}\n  Acceptance: ${t.acceptance}`).join('\n')

  const prompt = `Implement your assigned tasks. Work ONLY inside your worktree directory.

## Your Tasks
${taskList}

## Contracts (READ-ONLY reference)
${contractContent}

## Instructions
1. Implement each task following the contracts above exactly
2. Commit after each task: git commit -m "[${cfg.id}] task-id: description"
3. Run tests if available
4. If a contract is wrong or insufficient, include a note starting with "CR:" in your response`

  for await (const e of peer.send({type: 'implement', content: prompt})) {
    yield {type: 'peer_event', peerId: cfg.id, displayName: cfg.displayName, peerEvent: e} satisfies OrchEvent
  }

  await wm.commit(worktreePath, `[${cfg.id}] complete assigned tasks`)
  await peer.writeStatus({activeTasks: [], blockedBy: null, lastCommit: '', lastGateResult: {}, notes: 'Implementation complete'})
  yield {type: 'peer_phase', peerId: cfg.id, status: 'done'} satisfies OrchEvent
}

async function* peerFix(
  peer: Peer,
  cfg: PeerConfig,
  failingGates: string,
  iteration: number,
  worktreePath: string,
  wm: WorktreeManager
): AsyncIterable<OrchEvent> {
  const prompt = `Verification gates failed. Fix the issues in your worktree.

## Failing Gates
${failingGates}

## Instructions
- Fix only files in your worktree
- Do NOT modify contract files
- Run the failing commands to confirm your fix
- Commit your changes`

  yield {type: 'peer_phase', peerId: cfg.id, status: `fixing (iter ${iteration})`} satisfies OrchEvent
  for await (const e of peer.send({type: 'fix', content: prompt})) {
    yield {type: 'peer_event', peerId: cfg.id, displayName: cfg.displayName, peerEvent: e} satisfies OrchEvent
  }
  await wm.commit(worktreePath, `[${cfg.id}] fix gate failures (iter ${iteration})`)
}

// ── Main runner ──

export class OrchestrationRunner {
  async *run(opts: RunnerOptions): AsyncIterable<OrchEvent> {
    const {repoRoot, selectedPeers, conductorId} = opts
    const orch = new OrchManager(repoRoot)
    const wm = new WorktreeManager(repoRoot)
    const lock = new ContractLock(repoRoot)

    const conductor = selectedPeers.find(p => p.id === conductorId) ?? selectedPeers[0]
    const implementers = selectedPeers.filter(p => p.id !== conductor.id)

    // ── Create worktrees ──
    yield {type: 'log', message: 'Creating agent worktrees...'}
    const worktreePaths: Record<string, string> = {}
    for (const peer of selectedPeers) {
      const wt = await wm.create(peer.id)
      worktreePaths[peer.id] = wt
      yield {type: 'log', message: `  ${peer.id}: ${wt}`}
    }

    // Inject context files
    const brief = orch.readBrief()
    const peersJson = JSON.stringify(orch.readPeers() ?? {conductor: conductorId, peers: selectedPeers}, null, 2)
    for (const peer of selectedPeers) {
      const ctx = buildContextFile(peer, repoRoot, brief, peersJson)
      fs.writeFileSync(path.join(worktreePaths[peer.id], peer.contextFile), ctx)
    }

    // Instantiate peers + budget router
    const peers = new Map<string, Peer>()
    for (const cfg of selectedPeers) {
      peers.set(cfg.id, PeerFactory.create(cfg, repoRoot, worktreePaths[cfg.id]))
    }
    const conductorPeer = peers.get(conductor.id)!
    const router = new Router(selectedPeers, opts.budget)

    // Helper: track cost from peer events via the router
    function* trackCost(event: OrchEvent): Generator<OrchEvent> {
      if (event.type === 'peer_event' && event.peerEvent.type === 'result') {
        const cost = event.peerEvent.costUsd ?? 0
        const turns = event.peerEvent.turns ?? 0
        if (cost > 0) {
          const cfg = selectedPeers.find(p => p.id === event.peerId)
          if (cfg) router.recordUsage(cfg.id, cfg.provider, cost, turns)
        }
      }
      yield event
    }

    // ── Phase 1: Discussion (implementers in parallel) ──
    if (!opts.skipPlanning && implementers.length > 0) {
      yield {type: 'phase', phase: 'discuss', message: 'Phase 1: Discussion'}

      const discussions: Record<string, string> = {}
      const discussIters = implementers.map(cfg => {
        const peer = peers.get(cfg.id)!
        return (async function*(): AsyncIterable<OrchEvent> {
          let text = ''
          for await (const e of peerDiscuss(peer, cfg, conductor, brief)) {
            if (e.type === 'peer_event' && e.peerEvent.type === 'text') text += e.peerEvent.content ?? ''
            yield e
          }
          discussions[cfg.id] = text.slice(0, 800)
        })()
      })

      for await (const e of fanIn(discussIters)) yield* trackCost(e)

      // ── Phase 2: Planning (conductor) ──
      yield {type: 'phase', phase: 'planning', message: 'Phase 2: Planning'}

      const peerInput = Object.entries(discussions)
        .map(([id, resp]) => `## ${id}\n${resp}`)
        .join('\n\n')

      // Use structured output to get plan as valid JSON
      const planResult = await generatePlan(conductor, implementers, brief, opts.stack, peerInput, repoRoot)
      if (planResult.plan) {
        const planPath = path.join(repoRoot, '.orch', 'plan.json')
        fs.writeFileSync(planPath, JSON.stringify(planResult.plan, null, 2))
        yield {type: 'log', message: `✓ Plan created: ${planResult.plan.tasks.length} tasks`}

        // Write minimal contracts
        const contractsDir = path.join(repoRoot, '.orch', 'contracts')
        fs.mkdirSync(contractsDir, {recursive: true})
        fs.writeFileSync(path.join(contractsDir, 'VERSION'), String(planResult.plan.version))
      } else {
        yield {type: 'log', level: 'warn', message: `Plan generation failed: ${planResult.error}`}
      }
      if (planResult.costUsd) {
        router.recordUsage(conductor.id, conductor.provider, planResult.costUsd, 1)
      }
    } else if (!opts.skipPlanning) {
      // Conductor-only session, no discussion
      yield {type: 'phase', phase: 'planning', message: 'Phase 1: Planning'}

      const planResult = await generatePlan(conductor, implementers, brief, opts.stack, '', repoRoot)
      if (planResult.plan) {
        const planPath = path.join(repoRoot, '.orch', 'plan.json')
        fs.writeFileSync(planPath, JSON.stringify(planResult.plan, null, 2))
        yield {type: 'log', message: `✓ Plan created: ${planResult.plan.tasks.length} tasks`}
        const contractsDir = path.join(repoRoot, '.orch', 'contracts')
        fs.mkdirSync(contractsDir, {recursive: true})
        fs.writeFileSync(path.join(contractsDir, 'VERSION'), String(planResult.plan.version))
      } else {
        yield {type: 'log', level: 'warn', message: `Plan generation failed: ${planResult.error}`}
      }
      if (planResult.costUsd) router.recordUsage(conductor.id, conductor.provider, planResult.costUsd, 1)
    } else {
      yield {type: 'log', message: 'Skipping planning (contracts exist)'}
    }

    // ── Phase 3: Contract Review (all peers in parallel) ──
    if (!opts.skipReview) {
      yield {type: 'phase', phase: 'review', message: 'Phase 3: Contract Review'}

      const version = orch.readContractVersion()
      const contractHash = lock.hashContracts()
      const contractContent = readContractsForReview(orch)

      const reviewIters = selectedPeers.map(cfg => {
        const peer = peers.get(cfg.id)!
        return peerReview(peer, cfg, contractContent, version, contractHash, orch)
      })

      for await (const e of fanIn(reviewIters)) yield* trackCost(e)
    }

    // ── Phase 4: Lock ──
    yield {type: 'phase', phase: 'locked', message: 'Phase 4: Locking Contracts'}
    const version = orch.readContractVersion()
    lock.lock(conductor.id, version)
    await wm.tagContract(version)
    const lockedHash = lock.hashContracts()
    yield {type: 'contract_locked', version, hash: lockedHash}

    // ── Phase 5: Implementation (all peers in parallel) ──
    yield {type: 'phase', phase: 'implement', message: 'Phase 5: Implementation'}

    const plan = orch.readPlan()
    if (!plan || plan.tasks.length === 0) {
      yield {type: 'log', level: 'warn', message: 'No tasks in plan — skipping implementation'}
    } else {
      const tasksByOwner: Record<string, Task[]> = {}
      for (const task of plan.tasks) {
        if (!tasksByOwner[task.owner]) tasksByOwner[task.owner] = []
        tasksByOwner[task.owner].push(task)
      }

      const contractContent = readContractsForReview(orch)
      const knownCRIds = new Set(orch.listChangeRequests().map(cr => cr.id))

      const implIters = selectedPeers.map(cfg => {
        // Budget check before dispatching
        if (router.isOverBudget(cfg.id, cfg.provider)) {
          return (async function*(): AsyncIterable<OrchEvent> {
            yield {type: 'log', level: 'warn', message: `[${cfg.id}] over budget — skipping`}
          })()
        }
        const peer = peers.get(cfg.id)!
        const tasks = tasksByOwner[cfg.id] ?? []
        return peerImplement(peer, cfg, tasks, contractContent, worktreePaths[cfg.id], wm)
      })

      for await (const e of fanIn(implIters)) yield* trackCost(e)

      // Check for CRs filed during implementation
      const newCRs = orch.listChangeRequests().filter(cr => !knownCRIds.has(cr.id) && cr.status === 'pending')
      for (const cr of newCRs) {
        yield {type: 'cr_detected', cr}
        const crPrompt = `A Change Request was filed during implementation.

## CR
${JSON.stringify(cr, null, 2)}

Decide: ACCEPT or REJECT (explain why).
Respond with your decision and reasoning.`

        for await (const e of conductorPeer.send({type: 'review', content: crPrompt})) {
          yield {type: 'peer_event', peerId: conductor.id, displayName: conductor.displayName, peerEvent: e}
        }
      }
    }

    // ── Phase 6: Integration ──
    yield {type: 'phase', phase: 'integrate', message: 'Phase 6: Integration'}

    try {
      await wm.createIntegrationBranch()
      for (const peer of selectedPeers) {
        const {success, conflicts} = await wm.mergePeerBranch(peer.id)
        if (success) {
          yield {type: 'log', message: `  Merged agent/${peer.id} ✓`}
        } else {
          yield {type: 'log', level: 'warn', message: `  Conflicts in agent/${peer.id}: ${conflicts.join(', ')}`}
        }
      }
    } catch (err) {
      yield {type: 'log', level: 'warn', message: `Merge error: ${err}`}
    }

    // ── Verification gates + fix loop ──
    const gates = new VerificationGates(repoRoot)
    const validator = new ContractValidator(repoRoot)
    let gateResults!: GateResults
    let fixIter = 0

    do {
      const {results, outputs} = await gates.runAll()
      gateResults = results

      for (const [gate, result] of Object.entries(results) as Array<[string, GateResult]>) {
        yield {type: 'gate_result', gate, result, output: outputs[gate]}
      }

      if (gates.passed(gateResults)) break
      if (fixIter >= MAX_FIX) {
        yield {type: 'log', level: 'warn', message: `Remaining gate failures after ${MAX_FIX} iterations`}
        break
      }

      fixIter++
      yield {type: 'fix_iteration', n: fixIter, max: MAX_FIX}

      const failingGates = Object.entries(results)
        .filter(([, r]) => r === 'fail')
        .map(([gate]) => `### ${gate}\n${outputs[gate] ?? '(no output)'}`)
        .join('\n\n')

      // Send fix tasks to implementers + conductor for build failures
      const fixTargets = [...peers.values()].filter(p =>
        p.role === 'implementer' || failingGates.includes('build')
      )

      const fixIters = fixTargets.map(peer => {
        const cfg = selectedPeers.find(p => p.id === peer.id)!
        return peerFix(peer, cfg, failingGates, fixIter, worktreePaths[peer.id], wm)
      })

      for await (const e of fanIn(fixIters)) yield* trackCost(e)

      // Reset integration branch and re-merge all peers cleanly
      try {
        await wm.createIntegrationBranch()  // resets to main
        for (const p of selectedPeers) {
          const {success, conflicts} = await wm.mergePeerBranch(p.id)
          if (!success) {
            yield {type: 'log', level: 'warn', message: `  Conflicts in agent/${p.id}: ${conflicts.join(', ')}`} satisfies OrchEvent
          }
        }
      } catch (err) {
        yield {type: 'log', level: 'warn', message: `Re-merge error: ${err}`} satisfies OrchEvent
      }
    } while (fixIter < MAX_FIX)

    // Mismatch detection
    const mismatches = await validator.detectMismatches()
    if (mismatches.length > 0) {
      yield {type: 'log', level: 'warn', message: `Contract mismatches: ${mismatches.map(m => m.description).join('; ')}`}
    }

    validator.writeIntegrationReport(gateResults as unknown as Record<string, string>, mismatches, fixIter)

    for (const peer of peers.values()) await peer.shutdown()

    // Emit cost summary
    const costSummary = router.summary()
    if (costSummary.totalCost > 0) {
      const byPeer = Object.entries(costSummary.byPeer).map(([id, c]) => `${id}: $${c.toFixed(4)}`).join(', ')
      yield {type: 'log', message: `Cost summary: $${costSummary.totalCost.toFixed(4)} total (${byPeer})`}
    }

    yield {type: 'phase', phase: 'deliver', message: 'Phase 7: Done'}
    yield {type: 'complete'}
  }
}

// ── Helpers ──

function buildContextFile(peer: PeerConfig, repoRoot: string, brief: string, peersJson: string): string {
  return `# MetaCLiDE Context — ${peer.displayName}

## Your Role
You are **${peer.id}** (${peer.role}) in a MetaCLiDE multi-agent session.

## Invariants
1. Contracts are provided inline in prompts — never modify them directly
2. Only the Conductor may update contracts
3. All peers must ACK contracts before coding begins
4. To propose contract changes, include "CR:" in your response
5. Work only within your git worktree
6. Commit frequently with descriptive messages

## Project Brief
${brief}

## Active Peers
\`\`\`json
${peersJson}
\`\`\`
`
}

function readContractsForReview(orch: OrchManager): string {
  const files = [
    {label: 'api.openapi.yaml', p: orch.paths.contractApi},
    {label: 'pages.routes.json', p: orch.paths.contractRoutes},
    {label: 'entities.schema.json', p: orch.paths.contractEntities},
    {label: 'types.ts', p: orch.paths.contractTypes},
    {label: 'decisions.md', p: orch.paths.contractDecisions},
  ]
  return files
    .filter(f => fs.existsSync(f.p))
    .map(f => `### ${f.label}\n\`\`\`\n${fs.readFileSync(f.p, 'utf8')}\n\`\`\``)
    .join('\n\n')
}
