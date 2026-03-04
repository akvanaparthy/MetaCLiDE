import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawn} from 'node:child_process'
import {PluginManifestSchema} from '../orch/schema.js'
import type {PluginManifest} from '../../types.js'
import type {Peer} from '../peers/interface.js'
import type {PeerConfig, PeerMessage, PeerEvent, PeerStatusUpdate, Capability} from '../../types.js'
import {getCredential} from '../auth/keychain.js'

const PLUGINS_DIR = path.join(os.homedir(), '.metaclide', 'plugins')

export function listInstalledPlugins(): PluginManifest[] {
  if (!fs.existsSync(PLUGINS_DIR)) return []
  const manifests: PluginManifest[] = []
  for (const entry of fs.readdirSync(PLUGINS_DIR, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue
    const manifest = loadPluginManifest(entry.name)
    if (manifest) manifests.push(manifest)
  }
  return manifests
}

export function loadPluginManifest(pluginId: string): PluginManifest | null {
  const manifestPath = path.join(PLUGINS_DIR, pluginId, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const result = PluginManifestSchema.safeParse(raw)
    if (!result.success) return null
    return result.data as PluginManifest
  } catch {
    return null
  }
}

export async function createPluginPeer(
  config: PeerConfig,
  repoRoot: string,
  worktreePath: string,
): Promise<Peer> {
  const manifest = loadPluginManifest(config.id)
  if (!manifest) {
    throw new Error(
      `No plugin manifest found for "${config.id}" at ${path.join(PLUGINS_DIR, config.id, 'manifest.json')}`,
    )
  }

  if (manifest.entrypoint) {
    const pluginDir = path.join(PLUGINS_DIR, config.id)
    const entrypointPath = path.resolve(pluginDir, manifest.entrypoint)
    try {
      const mod = await import(entrypointPath)
      if (typeof mod.createPeer !== 'function') {
        throw new Error(`Plugin "${config.id}" entrypoint does not export createPeer()`)
      }
      return mod.createPeer(config, repoRoot, worktreePath) as Peer
    } catch (err) {
      throw new Error(
        `Failed to load entrypoint for plugin "${config.id}": ${(err as Error).message}`,
      )
    }
  }

  // Fallback: GenericCLIPeer
  return new GenericCLIPeer(config, manifest, repoRoot, worktreePath)
}

// ---------------------------------------------------------------------------
// GenericCLIPeer
// ---------------------------------------------------------------------------

export class GenericCLIPeer implements Peer {
  readonly id: string
  readonly mode: 'tool' | 'api'
  readonly role: 'conductor' | 'implementer'

  private readonly manifest: PluginManifest
  private readonly repoRoot: string
  private readonly worktreePath: string

  constructor(
    config: PeerConfig,
    manifest: PluginManifest,
    repoRoot: string,
    worktreePath: string,
  ) {
    this.id = config.id
    this.mode = config.type
    this.role = config.role
    this.manifest = manifest
    this.repoRoot = repoRoot
    this.worktreePath = worktreePath
  }

  capabilities(): Capability[] {
    return ['read', 'write', 'bash']
  }

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const execCmd = this.manifest.execCommand
    if (!execCmd) {
      yield {type: 'error', error: `Plugin "${this.id}" has no execCommand and no entrypoint`}
      return
    }

    // Resolve auth env var
    const env: Record<string, string> = {...(process.env as Record<string, string>)}
    const envVarName = this.manifest.envVars?.[0]
    if (envVarName) {
      const cred = await getCredential(this.id)
      if (cred) env[envVarName] = cred
    }

    const [cmd, ...args] = execCmd.split(/\s+/)
    const input = JSON.stringify(msg)

    yield* this._spawnAndStream(cmd, args, input, env)
  }

  private async *_spawnAndStream(
    cmd: string,
    args: string[],
    stdinPayload: string,
    env: Record<string, string>,
  ): AsyncIterable<PeerEvent> {
    const proc = spawn(cmd, args, {
      cwd: this.worktreePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdin.write(stdinPayload + '\n')
    proc.stdin.end()

    const lines: string[] = []
    let buffer = ''

    // Collect stdout lines
    const events: PeerEvent[] = []
    let resolveNext: (() => void) | null = null
    let done = false
    let error: string | null = null

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')

    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        lines.push(line)
        const event = parseNDJSON(line)
        events.push(event)
        resolveNext?.()
        resolveNext = null
      }
    })

    proc.stderr.on('data', (chunk: string) => {
      // Surface stderr as status events (best-effort)
      events.push({type: 'status', content: chunk.trim()})
      resolveNext?.()
      resolveNext = null
    })

    proc.on('close', (code) => {
      if (buffer.trim()) {
        const event = parseNDJSON(buffer.trim())
        events.push(event)
      }
      if (code !== 0) {
        error = `Plugin process exited with code ${code}`
        events.push({type: 'error', error: error})
      }
      done = true
      resolveNext?.()
      resolveNext = null
    })

    proc.on('error', (err) => {
      events.push({type: 'error', error: err.message})
      done = true
      resolveNext?.()
      resolveNext = null
    })

    let cursor = 0
    while (true) {
      if (cursor < events.length) {
        yield events[cursor++]
      } else if (done) {
        break
      } else {
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }
    }
  }

  async ackContract(version: number, hash: string): Promise<void> {
    // Best-effort: plugins that care can read .orch/status directly
    void version
    void hash
  }

  async writeStatus(update: PeerStatusUpdate): Promise<void> {
    void update
  }

  async shutdown(): Promise<void> {
    // Nothing to do for a stateless subprocess spawner
  }
}

function parseNDJSON(line: string): PeerEvent {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    // Accept events that already match PeerEvent shape
    if (
      typeof obj.type === 'string' &&
      ['text', 'tool_use', 'result', 'error', 'status'].includes(obj.type)
    ) {
      return obj as unknown as PeerEvent
    }
    // Otherwise wrap as text
    return {type: 'text', content: line}
  } catch {
    return {type: 'text', content: line}
  }
}
