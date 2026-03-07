// OrchestrationRunner — 6-phase pipeline as an async-generator event stream.
// Used by both `metaclide run` (CLI) and the TUI orchestrating phase.
import fs from 'node:fs'
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

  const prompt = `Implement your assigned tasks. Stay inside your worktree. Do NOT modify .orch/contracts/.

## Your Tasks
${taskList}

## Contracts (READ-ONLY)
${contractContent}

## Instructions
1. Implement each task following contracts exactly
2. Commit after each task: git commit -m "[${cfg.id}] task-id: description"
3. Run tests if available
4. Update .orch/status/${cfg.id}.json when done

If a contract is insufficient, write .orch/change-requests/CR-<id>.json and STOP work on affected areas.`

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
- Do NOT modify .orch/contracts/
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

      const planPrompt = `OUTPUT ONLY RAW JSON. No markdown, no explanation, no code fences. Just a JSON object.

Project: ${brief.split('\n').slice(0, 3).join(' ')}
Stack: ${opts.stack ?? 'Determine from brief'}
Peers: ${peerInput || '(none)'}
Team: ${implementers.map(p => `${p.id} (${p.role})`).join(', ')}

Return this exact JSON structure (nothing else):
{"version":1,"project":"NAME","tasks":[{"id":"task-001","title":"WHAT","owner":"PEER_ID","status":"pending","phase":"implement","dependencies":[],"acceptance":"CRITERIA"}]}`

      let planText = ''
      for await (const e of conductorPeer.send({type: 'plan', content: planPrompt})) {
        if (e.type === 'text') planText += e.content ?? ''
        yield* trackCost({type: 'peer_event', peerId: conductor.id, displayName: conductor.displayName, peerEvent: e})
      }

      // Extract plan JSON from conductor's response
      // Try to extract JSON: bare JSON, code-fenced, or regex fallback
      let jsonMatch: RegExpMatchArray | null = null
      try {
        JSON.parse(planText.trim())
        jsonMatch = [planText.trim(), planText.trim()]
      } catch {
        jsonMatch = planText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? planText.match(/(\{[\s\S]*"tasks"[\s\S]*\})/)
      }
      if (jsonMatch) {
        try {
          const raw = JSON.parse(jsonMatch[1]) as Record<string, unknown>
          // Normalize: ensure version, and fill in missing task fields
          const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map((t: Record<string, unknown>) => ({
            id: String(t.id ?? `task-${Math.random().toString(36).slice(2, 6)}`),
            title: String(t.title ?? ''),
            owner: String(t.owner ?? implementers[0]?.id ?? 'unknown'),
            status: String(t.status ?? 'pending') as Task['status'],
            phase: String(t.phase ?? 'implement'),
            dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
            acceptance: String(t.acceptance ?? ''),
          }))
          const plan: PlanFile = {
            version: Number(raw.version ?? raw.contractVersion ?? 1),
            project: String(raw.project ?? 'project'),
            tasks,
          }
          // Write plan.json
          const planPath = path.join(repoRoot, '.orch', 'plan.json')
          fs.writeFileSync(planPath, JSON.stringify(plan, null, 2))
          yield {type: 'log', message: `✓ Plan created: ${plan.tasks?.length ?? 0} tasks`}

          // Write minimal contracts
          const contractsDir = path.join(repoRoot, '.orch', 'contracts')
          fs.mkdirSync(contractsDir, {recursive: true})
          fs.writeFileSync(path.join(contractsDir, 'VERSION'), String(plan.version ?? 1))
          const contracts = raw.contracts as Record<string, unknown> | undefined
          const decisions = raw.decisions ?? contracts?.['decisions.md']
          if (decisions) {
            const text = Array.isArray(decisions) ? decisions.join('\n') : String(decisions)
            fs.writeFileSync(path.join(contractsDir, 'decisions.md'), text)
          }
        } catch (err) {
          yield {type: 'log', level: 'warn', message: `Could not parse plan JSON: ${err}`}
        }
      } else {
        yield {type: 'log', level: 'warn', message: 'Conductor did not return a JSON plan block'}
      }
    } else if (!opts.skipPlanning) {
      // Conductor-only session, no discussion
      yield {type: 'phase', phase: 'planning', message: 'Phase 1: Planning'}

      const planPrompt = `You are the Conductor for this session.

## Project Brief
${brief}

## Tech Stack
${opts.stack ?? 'Determine from brief'}

Create the canonical contracts (api.openapi.yaml, pages.routes.json, entities.schema.json, types.ts, decisions.md) and plan.json in .orch/. Set VERSION to 1.`

      for await (const e of conductorPeer.send({type: 'plan', content: planPrompt})) {
        yield* trackCost({type: 'peer_event', peerId: conductor.id, displayName: conductor.displayName, peerEvent: e})
      }
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

Decide: ACCEPT (update contracts, bump VERSION) or REJECT (explain why).
Update .orch/change-requests/${cr.id}.json with your resolution.
If accepted, update the relevant contract files.`

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
1. Contracts in \`.orch/contracts/\` are truth — never modify them directly
2. Only the Conductor may edit contracts
3. All peers must ACK contracts before coding begins
4. File a Change Request (CR) to propose contract changes
5. Work only within your git worktree
6. Commit frequently with descriptive messages

## Project Brief
${brief}

## Active Peers
\`\`\`json
${peersJson}
\`\`\`

## File Locations
- Contracts: \`.orch/contracts/\` (symlinked into your worktree as \`.orch\`)
- Your status: \`.orch/status/${peer.id}.json\`
- Change Requests: \`.orch/change-requests/\`
- Discussion threads: \`.orch/threads/\`
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
