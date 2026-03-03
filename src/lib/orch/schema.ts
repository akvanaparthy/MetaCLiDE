import {z} from 'zod'

export const PeerConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  type: z.enum(['tool', 'api']),
  provider: z.string(),
  mode: z.enum(['oauth', 'byok']),
  model: z.string().optional(),
  sessionFile: z.string().optional(),
  contextFile: z.string(),
  branch: z.string(),
  role: z.enum(['conductor', 'implementer']),
})

export const PeersFileSchema = z.object({
  conductor: z.string(),
  peers: z.array(PeerConfigSchema),
})

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  owner: z.string(),
  status: z.enum(['pending', 'in-progress', 'done', 'blocked', 'failed']),
  phase: z.string(),
  dependencies: z.array(z.string()),
  acceptance: z.string(),
  worktreePath: z.string().optional(),
})

export const PlanFileSchema = z.object({
  version: z.number(),
  project: z.string(),
  tasks: z.array(TaskSchema),
})

export const PeerStatusSchema = z.object({
  peer: z.string(),
  contractVersion: z.number(),
  contractHash: z.string(),
  activeTasks: z.array(z.string()),
  blockedBy: z.string().nullable(),
  lastCommit: z.string(),
  branch: z.string(),
  lastGateResult: z.record(z.enum(['pass', 'fail', 'skip'])),
  notes: z.string(),
})

export const ChangeRequestSchema = z.object({
  id: z.string(),
  from: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  what: z.string(),
  why: z.string(),
  proposed_change: z.string(),
  impact: z.array(z.string()),
  conductor_resolution: z.string().nullable(),
  resolved_at: z.string().nullable(),
})

export const PluginManifestSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string(),
  type: z.enum(['tool', 'api']),
  authMethod: z.enum(['oauth', 'byok']),
  sessionFile: z.string().optional(),
  contextFile: z.string(),
  loginCommand: z.string().optional(),
  execCommand: z.string().optional(),
  outputFormat: z.string().optional(),
  entrypoint: z.string().optional(),
  envVars: z.array(z.string()).optional(),
})
