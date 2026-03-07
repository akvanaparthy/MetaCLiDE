import fs from 'node:fs'
import path from 'node:path'
import {simpleGit, SimpleGit} from 'simple-git'
import {worktreePath as wtp} from '../orch/paths.js'

// Write a small .orch-root file so agents can find the real .orch directory
// without creating a recursive junction (.orch/worktrees/<peer>/.orch → .orch → infinite)
function writeOrchPointer(repoRoot: string, wtPath: string): void {
  const pointerPath = path.join(wtPath, '.orch-root')
  if (fs.existsSync(pointerPath)) return
  const orchSrc = path.join(repoRoot, '.orch')
  if (!fs.existsSync(orchSrc)) return
  fs.writeFileSync(pointerPath, orchSrc)
}

export class WorktreeManager {
  private git: SimpleGit

  constructor(private readonly repoRoot: string) {
    this.git = simpleGit(repoRoot)
  }

  async create(peerId: string): Promise<string> {
    const branch = `agent/${peerId}`
    const wtPath = wtp(this.repoRoot, peerId)

    // Check if worktree already exists
    if (fs.existsSync(wtPath)) {
      return wtPath
    }

    // Check if branch exists
    const branches = await this.git.branchLocal()
    if (branches.all.includes(branch)) {
      // Add worktree using existing branch
      await this.git.raw(['worktree', 'add', wtPath, branch])
    } else {
      // Create worktree with new branch from main/master
      const mainBranch = await this.getDefaultBranch()
      await this.git.raw(['worktree', 'add', '-b', branch, wtPath, mainBranch])
    }

    writeOrchPointer(this.repoRoot, wtPath)
    return wtPath
  }

  async injectContext(peerId: string, contextFileName: string, content: string): Promise<void> {
    const wtPath = wtp(this.repoRoot, peerId)
    const contextPath = path.join(wtPath, contextFileName)
    fs.writeFileSync(contextPath, content)
  }

  async remove(peerId: string): Promise<void> {
    const wtPath = wtp(this.repoRoot, peerId)
    if (!fs.existsSync(wtPath)) return
    await this.git.raw(['worktree', 'remove', '--force', wtPath])
  }

  async list(): Promise<string[]> {
    const result = await this.git.raw(['worktree', 'list', '--porcelain'])
    const worktrees: string[] = []
    for (const line of result.split('\n')) {
      if (line.startsWith('worktree ')) {
        const p = line.slice('worktree '.length).trim()
        if (p !== this.repoRoot) worktrees.push(p)
      }
    }
    return worktrees
  }

  async createIntegrationBranch(): Promise<void> {
    const mainBranch = await this.getDefaultBranch()
    const branches = await this.git.branchLocal()
    if (!branches.all.includes('integration')) {
      await this.git.raw(['checkout', '-b', 'integration', mainBranch])
    } else {
      await this.git.raw(['checkout', 'integration'])
      await this.git.raw(['reset', '--hard', mainBranch])
    }
  }

  async mergePeerBranch(peerId: string): Promise<{success: boolean; conflicts: string[]}> {
    const branch = `agent/${peerId}`
    try {
      await this.git.raw(['merge', '--no-ff', branch, '-m', `Merge ${branch} into integration`])
      return {success: true, conflicts: []}
    } catch (err) {
      const conflicts = await this.getConflicts()
      return {success: false, conflicts}
    }
  }

  async getConflicts(): Promise<string[]> {
    const status = await this.git.status()
    return status.conflicted
  }

  async tagContract(version: number): Promise<void> {
    const tag = `contract-v${version}`
    const tags = await this.git.tags()
    if (!tags.all.includes(tag)) {
      await this.git.addTag(tag)
    }
  }

  async commit(wtPath: string, message: string): Promise<string> {
    const wGit = simpleGit(wtPath)
    await wGit.add('.')
    try {
      const result = await wGit.commit(message)
      return result.commit ?? ''
    } catch {
      // Nothing to commit (clean tree)
      return await this.getLastCommit(wtPath)
    }
  }

  async getLastCommit(wtPath: string): Promise<string> {
    const wGit = simpleGit(wtPath)
    const log = await wGit.log(['-1'])
    return log.latest?.hash ?? ''
  }

  private async getDefaultBranch(): Promise<string> {
    try {
      const result = await this.git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])
      return result.trim().replace('refs/remotes/origin/', '')
    } catch {
      // Fallback: check local branches
      const branches = await this.git.branchLocal()
      if (branches.all.includes('main')) return 'main'
      if (branches.all.includes('master')) return 'master'
      return 'HEAD'
    }
  }

  getWorktreePath(peerId: string): string {
    return wtp(this.repoRoot, peerId)
  }

  async pruneStale(): Promise<void> {
    await this.git.raw(['worktree', 'prune'])
  }
}
