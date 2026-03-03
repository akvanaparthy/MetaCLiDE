import fs from 'node:fs'
import path from 'node:path'
import {orchPaths} from './paths.js'
import type {PeersFile, PlanFile, PeerStatus, ChangeRequest} from '../../types.js'
import {PeersFileSchema, PlanFileSchema, PeerStatusSchema, ChangeRequestSchema} from './schema.js'

export class OrchManager {
  readonly paths: ReturnType<typeof orchPaths>

  constructor(public readonly repoRoot: string) {
    this.paths = orchPaths(repoRoot)
  }

  exists(): boolean {
    return fs.existsSync(this.paths.root)
  }

  init(projectName?: string): void {
    const dirs = [
      this.paths.root,
      this.paths.contracts,
      this.paths.status,
      this.paths.changeRequests,
      this.paths.threads,
      this.paths.logs,
      this.paths.worktrees,
    ]
    for (const dir of dirs) {
      fs.mkdirSync(dir, {recursive: true})
    }

    // brief.md
    if (!fs.existsSync(this.paths.brief)) {
      const heading = projectName ? `# ${projectName}` : '# Project'
      fs.writeFileSync(this.paths.brief, `${heading}\n\n<!-- Brief will be written by the Conductor agent -->\n`)
    }

    // contracts/VERSION
    if (!fs.existsSync(this.paths.contractVersion)) {
      fs.writeFileSync(this.paths.contractVersion, '0')
    }

    // contracts/decisions.md
    if (!fs.existsSync(this.paths.contractDecisions)) {
      fs.writeFileSync(this.paths.contractDecisions, '# Architecture Decisions\n\n')
    }
  }

  readPeers(): PeersFile | null {
    if (!fs.existsSync(this.paths.peers)) return null
    const raw = JSON.parse(fs.readFileSync(this.paths.peers, 'utf8'))
    return PeersFileSchema.parse(raw)
  }

  writePeers(data: PeersFile): void {
    fs.writeFileSync(this.paths.peers, JSON.stringify(data, null, 2))
  }

  readPlan(): PlanFile | null {
    if (!fs.existsSync(this.paths.plan)) return null
    const raw = JSON.parse(fs.readFileSync(this.paths.plan, 'utf8'))
    return PlanFileSchema.parse(raw)
  }

  writePlan(data: PlanFile): void {
    fs.writeFileSync(this.paths.plan, JSON.stringify(data, null, 2))
  }

  readPeerStatus(peerId: string): PeerStatus | null {
    const p = path.join(this.paths.status, `${peerId}.json`)
    if (!fs.existsSync(p)) return null
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return PeerStatusSchema.parse(raw)
  }

  writePeerStatus(status: PeerStatus): void {
    const p = path.join(this.paths.status, `${status.peer}.json`)
    fs.writeFileSync(p, JSON.stringify(status, null, 2))
  }

  readChangeRequest(crId: string): ChangeRequest | null {
    const p = path.join(this.paths.changeRequests, `${crId}.json`)
    if (!fs.existsSync(p)) return null
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return ChangeRequestSchema.parse(raw)
  }

  writeChangeRequest(cr: ChangeRequest): void {
    const p = path.join(this.paths.changeRequests, `${cr.id}.json`)
    fs.writeFileSync(p, JSON.stringify(cr, null, 2))
  }

  listChangeRequests(): ChangeRequest[] {
    if (!fs.existsSync(this.paths.changeRequests)) return []
    const files = fs.readdirSync(this.paths.changeRequests).filter(f => f.endsWith('.json'))
    return files.map(f => {
      const raw = JSON.parse(fs.readFileSync(path.join(this.paths.changeRequests, f), 'utf8'))
      return ChangeRequestSchema.parse(raw)
    })
  }

  readContractVersion(): number {
    if (!fs.existsSync(this.paths.contractVersion)) return 0
    return parseInt(fs.readFileSync(this.paths.contractVersion, 'utf8').trim(), 10) || 0
  }

  bumpContractVersion(): number {
    const next = this.readContractVersion() + 1
    fs.writeFileSync(this.paths.contractVersion, String(next))
    return next
  }

  readBrief(): string {
    if (!fs.existsSync(this.paths.brief)) return ''
    return fs.readFileSync(this.paths.brief, 'utf8')
  }

  readProjectName(): string {
    const brief = this.readBrief()
    const match = brief.match(/^#\s+(.+)/m)
    const name = match?.[1]?.trim() ?? ''
    // Don't return the default placeholder name
    return name === 'Project' ? '' : name
  }

  writeBrief(content: string): void {
    fs.writeFileSync(this.paths.brief, content)
  }

  appendThread(threadId: string, content: string): void {
    const p = path.join(this.paths.threads, `${threadId}.md`)
    fs.appendFileSync(p, content + '\n')
  }

  allPeerStatuses(): PeerStatus[] {
    if (!fs.existsSync(this.paths.status)) return []
    const files = fs.readdirSync(this.paths.status).filter(f => f.endsWith('.json'))
    return files.map(f => {
      const raw = JSON.parse(fs.readFileSync(path.join(this.paths.status, f), 'utf8'))
      return PeerStatusSchema.parse(raw)
    })
  }
}

export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let current = startDir
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function requireOrch(repoRoot?: string): {orch: OrchManager; root: string} {
  const root = repoRoot ?? findRepoRoot()
  if (!root) throw new Error('Not inside a git repository. Run git init first.')
  const orch = new OrchManager(root)
  if (!orch.exists()) throw new Error('No .orch directory found. Run `metaclide init` first.')
  return {orch, root}
}
