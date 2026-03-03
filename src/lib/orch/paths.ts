import path from 'node:path'

export function orchRoot(repoRoot: string): string {
  return path.join(repoRoot, '.orch')
}

export function orchPaths(repoRoot: string) {
  const root = orchRoot(repoRoot)
  return {
    root,
    brief: path.join(root, 'brief.md'),
    peers: path.join(root, 'peers.json'),
    plan: path.join(root, 'plan.json'),
    lock: path.join(root, 'LOCK.contracts'),
    contracts: path.join(root, 'contracts'),
    contractVersion: path.join(root, 'contracts', 'VERSION'),
    contractApi: path.join(root, 'contracts', 'api.openapi.yaml'),
    contractRoutes: path.join(root, 'contracts', 'pages.routes.json'),
    contractEntities: path.join(root, 'contracts', 'entities.schema.json'),
    contractTypes: path.join(root, 'contracts', 'types.ts'),
    contractDb: path.join(root, 'contracts', 'db-schema.prisma'),
    contractDecisions: path.join(root, 'contracts', 'decisions.md'),
    status: path.join(root, 'status'),
    changeRequests: path.join(root, 'change-requests'),
    threads: path.join(root, 'threads'),
    logs: path.join(root, 'logs'),
    worktrees: path.join(root, 'worktrees'),
    integrationReport: path.join(root, 'integration-report.md'),
  }
}

export function peerStatusPath(repoRoot: string, peerId: string): string {
  return path.join(orchRoot(repoRoot), 'status', `${peerId}.json`)
}

export function peerLogPath(repoRoot: string, peerId: string): string {
  return path.join(orchRoot(repoRoot), 'logs', `${peerId}.jsonl`)
}

export function worktreePath(repoRoot: string, peerId: string): string {
  return path.join(orchRoot(repoRoot), 'worktrees', peerId)
}

export function crPath(repoRoot: string, crId: string): string {
  return path.join(orchRoot(repoRoot), 'change-requests', `${crId}.json`)
}

export function threadPath(repoRoot: string, threadId: string): string {
  return path.join(orchRoot(repoRoot), 'threads', `${threadId}.md`)
}
