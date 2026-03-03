import {Command, Flags} from '@oclif/core'
import {requireOrch, OrchManager} from '../lib/orch/index.js'
import {getCredential} from '../lib/auth/keychain.js'
import {WorktreeManager} from '../lib/git/worktree.js'
import {ContractLock} from '../lib/contracts/lock.js'
import {ContractValidator} from '../lib/contracts/validation.js'
import {VerificationGates} from '../lib/gates/index.js'
import {PeerFactory} from '../lib/peers/factory.js'
import {SessionLogger} from '../lib/logger/index.js'
import type {PeerConfig, Task, PlanFile, GateResults} from '../types.js'
import type {Peer} from '../lib/peers/interface.js'
import fs from 'node:fs'
import path from 'node:path'

const MAX_FIX_ITERATIONS = 5

export default class Run extends Command {
  static description = 'Start a multi-agent coding session'

  static examples = [
    '<%= config.bin %> run',
    '<%= config.bin %> run --agents claude,codex',
    '<%= config.bin %> run --non-interactive --agents claude,kimi --budget anthropic=3,moonshot=2',
  ]

  static flags = {
    agents: Flags.string({
      char: 'a',
      description: 'Comma-separated agent ids to use (default: all configured)',
    }),
    budget: Flags.string({
      char: 'b',
      description: 'Budget limits, e.g. anthropic=3,openai=5 (USD per session)',
    }),
    'non-interactive': Flags.boolean({
      description: 'Run without interactive prompts',
      default: false,
    }),
    stack: Flags.string({
      description: 'Tech stack hint (e.g. "nextjs,prisma,postgres")',
    }),
    'skip-planning': Flags.boolean({description: 'Skip planning phase if contracts exist'}),
    'skip-review': Flags.boolean({description: 'Skip contract review (auto-ACK)'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Run)
    const {orch, root} = requireOrch()

    // Load peers
    const peersFile = orch.readPeers()
    if (!peersFile || peersFile.peers.length < 2) {
      this.error('Need at least 2 peers configured. Run `metaclide agents add` to add agents.')
    }

    // Filter peers if --agents flag given
    let selectedPeers = peersFile.peers
    if (flags.agents) {
      const ids = flags.agents.split(',').map(s => s.trim())
      selectedPeers = peersFile.peers.filter(p => ids.includes(p.id))
      if (selectedPeers.length < 2) {
        this.error(`Selected agents (${ids.join(',')}) must include at least 2 configured peers.`)
      }
    }

    // Resolve API keys from keychain
    for (const peer of selectedPeers) {
      if (peer.mode === 'byok') {
        const key = await getCredential(peer.id)
        if (key) peer.apiKey = key
      }
    }

    // Parse budget
    const budget: Record<string, number> = {}
    if (flags.budget) {
      for (const part of flags.budget.split(',')) {
        const [k, v] = part.trim().split('=')
        if (k && v) budget[k] = parseFloat(v)
      }
    }

    const conductorId = peersFile.conductor || selectedPeers[0].id
    const conductor = selectedPeers.find(p => p.id === conductorId) ?? selectedPeers[0]
    if (!conductor) {
      this.error('No conductor peer found. Check peers.json.')
    }

    this.log(`Starting MetaCLiDE session`)
    this.log(`Conductor: ${conductor.displayName}`)
    this.log(`Peers: ${selectedPeers.map(p => p.displayName).join(', ')}`)
    this.log('')

    // Initialize git worktrees
    const wm = new WorktreeManager(root)
    const worktreePaths: Record<string, string> = {}

    this.log('Creating worktrees...')
    for (const peer of selectedPeers) {
      const wtPath = await wm.create(peer.id)
      worktreePaths[peer.id] = wtPath
      this.log(`  ${peer.id}: ${wtPath}`)
    }
    this.log('')

    // Inject context files into worktrees
    await this.injectContextFiles(selectedPeers, worktreePaths, root, orch)

    // Create peer instances
    const peers = new Map<string, Peer>()
    for (const cfg of selectedPeers) {
      peers.set(cfg.id, PeerFactory.create(cfg, root, worktreePaths[cfg.id]))
    }

    const logger = new SessionLogger(root)
    const contractLock = new ContractLock(root)

    // --- PHASE 1: PLANNING ---
    const contractsExist = this.contractsExist(root, orch)
    if (!contractsExist || !flags['skip-planning']) {
      this.log('=== Phase 1: Planning ===')
      await this.runPlanningPhase(peers, conductor, selectedPeers, orch, root, logger, flags.stack)
    } else {
      this.log('Contracts found, skipping planning phase.')
    }

    // --- PHASE 2: CONTRACT REVIEW ---
    if (!flags['skip-review']) {
      this.log('')
      this.log('=== Phase 2: Contract Review ===')
      await this.runReviewPhase(peers, selectedPeers, contractLock, orch, root)
    }

    // --- PHASE 3: LOCK ---
    this.log('')
    this.log('=== Phase 3: Locking Contracts ===')
    const version = orch.readContractVersion()
    contractLock.lock(conductorId, version)
    await wm.tagContract(version)
    this.log(`Contracts locked at version ${version}`)

    // --- PHASE 4: IMPLEMENTATION ---
    this.log('')
    this.log('=== Phase 4: Implementation ===')
    const plan = orch.readPlan()
    if (!plan || plan.tasks.length === 0) {
      this.log('No tasks in plan. Skipping implementation.')
    } else {
      await this.runImplementationPhase(peers, selectedPeers, plan, orch, root, worktreePaths, logger, wm)
    }

    // --- PHASE 5: INTEGRATION ---
    this.log('')
    this.log('=== Phase 5: Integration ===')
    await this.runIntegrationPhase(selectedPeers, root, orch, wm)

    // --- PHASE 6: DELIVERY ---
    this.log('')
    this.log('=== Phase 6: Delivery ===')
    this.log('Integration complete. See .orch/integration-report.md for details.')
    this.log('')
    this.log('Session complete.')

    // Shutdown all peers
    for (const peer of peers.values()) {
      await peer.shutdown()
    }
  }

  private async injectContextFiles(
    peers: PeerConfig[],
    worktreePaths: Record<string, string>,
    repoRoot: string,
    orch: OrchManager
  ): Promise<void> {
    const brief = orch.readBrief()
    const peers_json = JSON.stringify(orch.readPeers() ?? {conductor: '', peers: []}, null, 2)

    for (const peer of peers) {
      const wtPath = worktreePaths[peer.id]
      const contextContent = this.buildContextFile(peer, repoRoot, brief, peers_json)
      fs.writeFileSync(path.join(wtPath, peer.contextFile), contextContent)
    }
  }

  private buildContextFile(
    peer: PeerConfig,
    repoRoot: string,
    brief: string,
    peersJson: string
  ): string {
    return `# MetaCLiDE Context — ${peer.displayName}

## Your Role
You are **${peer.id}** (${peer.role}) in a MetaCLiDE multi-agent session.

## Invariants
1. Contracts in \`.orch/contracts/\` are truth — never modify them directly
2. Only the Conductor (${peer.role === 'conductor' ? 'YOU' : 'another peer'}) may edit contracts
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
- Contracts: \`.orch/contracts/\`
- Your status: \`.orch/status/${peer.id}.json\`
- Change Requests: \`.orch/change-requests/\`
- Discussion: \`.orch/threads/\`
`
  }

  private contractsExist(repoRoot: string, orch: OrchManager): boolean {
    return fs.existsSync(orch.paths.contractApi) || fs.existsSync(orch.paths.contractTypes)
  }

  private async runPlanningPhase(
    peers: Map<string, Peer>,
    conductor: PeerConfig,
    allPeers: PeerConfig[],
    orch: OrchManager,
    repoRoot: string,
    logger: SessionLogger,
    stack?: string
  ): Promise<void> {
    const conductorPeer = peers.get(conductor.id)!
    const brief = orch.readBrief()

    const implementersList = allPeers
      .filter(p => p.id !== conductor.id)
      .map(p => `- ${p.displayName} (${p.id}): ${p.role}`)
      .join('\n')

    const planningPrompt = `
You are the Conductor for this MetaCLiDE session. Your job is to:

1. Read the project brief below
2. Create the canonical contracts in .orch/contracts/:
   - api.openapi.yaml — OpenAPI 3.0 spec for all backend endpoints
   - pages.routes.json — frontend routes to components to endpoints
   - entities.schema.json — shared data models (JSON Schema)
   - types.ts — TypeScript interfaces
   - decisions.md — architecture decisions
3. Create .orch/plan.json with tasks for each peer
4. Update .orch/contracts/VERSION to 1

## Project Brief
${brief}

## Tech Stack
${stack ?? 'Determine from the brief'}

## Team Peers
${implementersList}

## plan.json format
{
  "version": 1,
  "project": "<name>",
  "tasks": [
    {
      "id": "task-001",
      "title": "...",
      "owner": "<peer-id>",
      "status": "pending",
      "phase": "implement",
      "dependencies": [],
      "acceptance": "..."
    }
  ]
}

Start by reading the brief, then create all contract files and the plan. Be thorough — these contracts will guide the entire session.
`.trim()

    this.log(`Conductor (${conductor.displayName}) is planning...`)

    for await (const event of conductorPeer.send({
      type: 'plan',
      content: planningPrompt,
    })) {
      if (event.type === 'text' && event.content) {
        process.stdout.write('.')
      } else if (event.type === 'result') {
        this.log('\nPlanning complete.')
        if (event.costUsd) this.log(`Cost: $${event.costUsd.toFixed(4)}`)
      } else if (event.type === 'error') {
        this.warn(`Planning error: ${event.error}`)
      }
    }
  }

  private async runReviewPhase(
    peers: Map<string, Peer>,
    allPeers: PeerConfig[],
    contractLock: ContractLock,
    orch: OrchManager,
    repoRoot: string
  ): Promise<void> {
    const version = orch.readContractVersion()
    const hash = contractLock.hashContracts()

    const reviewPromises = allPeers.map(async cfg => {
      const peer = peers.get(cfg.id)!
      const contractContent = this.readContractsForReview(repoRoot, orch)

      const reviewPrompt = `
Review the contracts below and respond with either:
- ACK — if you accept all contracts and can implement your tasks
- REJECT — if you need changes (specify what and why in a Change Request)

## Contracts to Review
${contractContent}

## Your Tasks (from plan.json)
Review the tasks assigned to you and confirm you can complete them within the contract spec.

Respond with "ACK" followed by a brief summary of your implementation plan, OR "REJECT" with specific issues.
`.trim()

      this.log(`  Sending contracts to ${cfg.displayName} for review...`)

      for await (const event of peer.send({type: 'review', content: reviewPrompt})) {
        if (event.type === 'result' || event.type === 'text') {
          if (event.content?.startsWith('ACK')) {
            await peer.ackContract(version, hash)
            this.log(`  ${cfg.displayName}: ACK`)
          } else if (event.content?.startsWith('REJECT')) {
            this.log(`  ${cfg.displayName}: REJECT — ${event.content.slice(6, 100)}...`)
          }
        }
      }
    })

    await Promise.all(reviewPromises)
  }

  private readContractsForReview(
    repoRoot: string,
    orch: OrchManager
  ): string {
    const files = [
      {label: 'api.openapi.yaml', path: orch.paths.contractApi},
      {label: 'pages.routes.json', path: orch.paths.contractRoutes},
      {label: 'entities.schema.json', path: orch.paths.contractEntities},
      {label: 'types.ts', path: orch.paths.contractTypes},
      {label: 'decisions.md', path: orch.paths.contractDecisions},
    ]
    return files
      .filter(f => fs.existsSync(f.path))
      .map(f => `### ${f.label}\n\`\`\`\n${fs.readFileSync(f.path, 'utf8')}\n\`\`\``)
      .join('\n\n')
  }

  private async runImplementationPhase(
    peers: Map<string, Peer>,
    allPeers: PeerConfig[],
    plan: PlanFile,
    orch: OrchManager,
    repoRoot: string,
    worktreePaths: Record<string, string>,
    logger: SessionLogger,
    wm: WorktreeManager
  ): Promise<void> {
    // Group tasks by owner
    const tasksByOwner: Record<string, Task[]> = {}
    for (const task of plan.tasks) {
      if (!tasksByOwner[task.owner]) tasksByOwner[task.owner] = []
      tasksByOwner[task.owner].push(task)
    }

    const contractContent = this.readContractsForReview(repoRoot, orch)

    // Run all peers in parallel
    const implPromises = allPeers.map(async cfg => {
      const tasks = tasksByOwner[cfg.id] ?? []
      if (tasks.length === 0) {
        this.log(`  ${cfg.displayName}: no tasks assigned`)
        return
      }

      const peer = peers.get(cfg.id)!
      this.log(`  ${cfg.displayName}: implementing ${tasks.length} task(s)`)

      const taskList = tasks
        .map(t => `- [${t.id}] ${t.title}\n  Acceptance: ${t.acceptance}`)
        .join('\n')

      const implPrompt = `
Implement your assigned tasks. Work in your worktree only. Do NOT modify .orch/contracts/.

## Your Tasks
${taskList}

## Contracts (READ-ONLY reference)
${contractContent}

## Instructions
1. Implement each task, following the contract specifications exactly
2. Commit after completing each task: git commit -m "[${cfg.id}] task-XXX: description"
3. Run tests if available
4. Update .orch/status/${cfg.id}.json with your progress

If you need a contract change, write a Change Request to .orch/change-requests/CR-<id>.json and STOP work on affected areas.
`.trim()

      await peer.writeStatus({
        activeTasks: tasks.map(t => t.id),
        blockedBy: null,
        lastCommit: '',
        lastGateResult: {},
        notes: 'Starting implementation',
      })

      for await (const event of peer.send({type: 'implement', content: implPrompt})) {
        if (event.type === 'text' && event.content) {
          process.stdout.write(`[${cfg.id}] `)
        } else if (event.type === 'result') {
          this.log(`\n  ${cfg.displayName}: implementation done`)
          if (event.costUsd) this.log(`    Cost: $${event.costUsd.toFixed(4)}`)

          // Commit remaining changes
          const lastCommit = await wm.commit(
            worktreePaths[cfg.id],
            `[${cfg.id}] Complete assigned tasks`
          )
          await peer.writeStatus({
            activeTasks: [],
            blockedBy: null,
            lastCommit,
            lastGateResult: {},
            notes: 'Implementation complete',
          })
        } else if (event.type === 'error') {
          this.warn(`\n  ${cfg.displayName} error: ${event.error}`)
        }
      }
    })

    await Promise.all(implPromises)
  }

  private async runIntegrationPhase(
    allPeers: PeerConfig[],
    repoRoot: string,
    orch: OrchManager,
    wm: WorktreeManager
  ): Promise<void> {
    const validator = new ContractValidator(repoRoot)
    const gates = new VerificationGates(repoRoot)

    // Create integration branch and merge all peer branches
    try {
      await wm.createIntegrationBranch()
      this.log('Created integration branch')

      for (const peer of allPeers) {
        this.log(`  Merging agent/${peer.id}...`)
        const {success, conflicts} = await wm.mergePeerBranch(peer.id)
        if (!success) {
          this.warn(`  Conflicts in agent/${peer.id}: ${conflicts.join(', ')}`)
        } else {
          this.log(`  Merged agent/${peer.id}`)
        }
      }
    } catch (err) {
      this.warn(`Integration merge error: ${err}`)
    }

    // Run verification gates
    this.log('Running verification gates...')
    let gateResults: GateResults
    let fixIterations = 0

    do {
      gateResults = await gates.runAll()
      this.log(`  lint: ${gateResults.lint}, typecheck: ${gateResults.typecheck}, test: ${gateResults.test}, build: ${gateResults.build}`)

      if (gates.passed(gateResults) || fixIterations >= MAX_FIX_ITERATIONS) break

      fixIterations++
      this.log(`  Gate failure — fix iteration ${fixIterations}/${MAX_FIX_ITERATIONS}`)
    } while (fixIterations < MAX_FIX_ITERATIONS)

    // Detect contract mismatches
    const mismatches = await validator.detectMismatches()
    if (mismatches.length > 0) {
      this.warn(`Contract mismatches detected: ${mismatches.length}`)
      for (const m of mismatches) this.warn(`  [${m.type}] ${m.description}`)
    }

    // Write integration report
    validator.writeIntegrationReport(
      gateResults as unknown as Record<string, string>,
      mismatches,
      fixIterations
    )
  }
}
