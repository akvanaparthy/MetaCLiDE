// Core shared TypeScript types for MetaCLiDE

export type PeerMode = 'tool' | 'api'
export type PeerRole = 'conductor' | 'implementer'
export type AuthMode = 'oauth' | 'byok'
export type TaskStatus = 'pending' | 'in-progress' | 'done' | 'blocked' | 'failed'
export type Phase = 'planning' | 'review' | 'locked' | 'implement' | 'integrate' | 'deliver'
export type GateResult = 'pass' | 'fail' | 'skip'
export type CRStatus = 'pending' | 'accepted' | 'rejected'

export interface PeerConfig {
  id: string
  displayName: string
  type: PeerMode
  provider: 'anthropic' | 'openai' | 'moonshot' | string
  mode: AuthMode
  model?: string
  sessionFile?: string
  contextFile: string
  branch: string
  role: PeerRole
  apiKey?: string  // resolved at runtime from keychain
}

export interface PeersFile {
  conductor: string
  peers: PeerConfig[]
}

export interface Task {
  id: string
  title: string
  owner: string
  status: TaskStatus
  phase: string
  dependencies: string[]
  acceptance: string
  worktreePath?: string
}

export interface PlanFile {
  version: number
  project: string
  tasks: Task[]
}

export interface PeerStatus {
  peer: string
  contractVersion: number
  contractHash: string
  activeTasks: string[]
  blockedBy: string | null
  lastCommit: string
  branch: string
  lastGateResult: Record<string, GateResult>
  notes: string
}

export interface ChangeRequest {
  id: string
  from: string
  status: CRStatus
  what: string
  why: string
  proposed_change: string
  impact: string[]
  conductor_resolution: string | null
  resolved_at: string | null
}

export interface PeerMessage {
  type: 'plan' | 'review' | 'implement' | 'fix' | 'integrate' | 'discuss'
  taskId?: string
  content: string
  attachments?: { path: string; content: string }[]
}

export interface PeerEvent {
  type: 'text' | 'tool_use' | 'result' | 'error' | 'status'
  content?: string
  toolName?: string
  toolInput?: unknown
  costUsd?: number
  turns?: number
  error?: string
}

export interface PeerStatusUpdate {
  activeTasks: string[]
  blockedBy: string | null
  lastCommit: string
  lastGateResult: Record<string, GateResult>
  notes: string
}

export type Capability = 'read' | 'write' | 'bash' | 'browser' | 'search' | 'test'

export interface GateResults {
  lint: GateResult
  typecheck: GateResult
  test: GateResult
  build: GateResult
  e2e: GateResult
}

export interface IntegrationReport {
  phase: Phase
  gateResults: GateResults
  mismatches: string[]
  fixIterations: number
  timestamp: string
}

export interface BudgetConfig {
  perProvider: Record<string, number>  // USD per day
  perAgentSession: number              // USD
  perPhase: number                     // USD
}

export interface RunOptions {
  agents: string[]
  budget?: Partial<BudgetConfig>
  nonInteractive: boolean
  stack?: string
  brief?: string
}

export interface PluginManifest {
  id: string
  displayName: string
  version: string
  type: PeerMode
  authMethod: AuthMode
  sessionFile?: string
  contextFile: string
  loginCommand?: string
  execCommand?: string
  outputFormat?: string
  entrypoint?: string
  envVars?: string[]
}
