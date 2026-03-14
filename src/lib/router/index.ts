// In-process router: routes tasks to peers by capability, enforces budgets
import type {PeerConfig, BudgetConfig, Capability} from '../../types.js'

export interface UsageRecord {
  peerId: string
  provider: string
  costUsd: number
  tokens: number
  timestamp: string
}

export class Router {
  private usage: UsageRecord[] = []
  private sessionCosts: Record<string, number> = {}
  private phaseCost = 0
  private currentPhase = ''

  constructor(
    private readonly peers: PeerConfig[],
    private readonly budget: BudgetConfig = {
      perProvider: {},
      perAgentSession: 10,
      perPhase: 5,
    }
  ) {}

  setPhase(phase: string): void {
    this.currentPhase = phase
    this.phaseCost = 0
  }

  recordUsage(peerId: string, provider: string, costUsd: number, tokens: number): void {
    this.usage.push({peerId, provider, costUsd, tokens, timestamp: new Date().toISOString()})
    this.sessionCosts[peerId] = (this.sessionCosts[peerId] ?? 0) + costUsd
    this.phaseCost += costUsd
  }

  getPhaseCost(): number { return this.phaseCost }

  getSessionCost(peerId: string): number {
    return this.sessionCosts[peerId] ?? 0
  }

  getTotalCost(): number {
    return this.usage.reduce((sum, r) => sum + r.costUsd, 0)
  }

  getProviderCost(provider: string): number {
    return this.usage.filter(r => r.provider === provider).reduce((sum, r) => sum + r.costUsd, 0)
  }

  isOverBudget(peerId: string, provider: string): boolean {
    const sessionCost = this.getSessionCost(peerId)
    if (sessionCost >= this.budget.perAgentSession) return true

    const providerLimit = this.budget.perProvider[provider]
    if (providerLimit !== undefined && this.getProviderCost(provider) >= providerLimit) return true

    if (this.phaseCost >= this.budget.perPhase) return true

    return false
  }

  // Select best peer for a task based on capabilities and current load
  selectPeer(
    requiredCapabilities: Capability[],
    excludePeerIds: string[] = []
  ): PeerConfig | null {
    const available = this.peers.filter(
      p => !excludePeerIds.includes(p.id) && !this.isOverBudget(p.id, p.provider)
    )
    if (available.length === 0) return null
    // Simple heuristic: prefer implementers, then conductors
    const implementer = available.find(p => p.role === 'implementer')
    return implementer ?? available[0]
  }

  summary(): {totalCost: number; byPeer: Record<string, number>; byProvider: Record<string, number>} {
    const byPeer: Record<string, number> = {}
    const byProvider: Record<string, number> = {}
    for (const r of this.usage) {
      byPeer[r.peerId] = (byPeer[r.peerId] ?? 0) + r.costUsd
      byProvider[r.provider] = (byProvider[r.provider] ?? 0) + r.costUsd
    }
    return {totalCost: this.getTotalCost(), byPeer, byProvider}
  }
}
