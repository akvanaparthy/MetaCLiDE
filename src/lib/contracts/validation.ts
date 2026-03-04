import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'
import {orchPaths} from '../orch/paths.js'

export interface MismatchResult {
  type: 'api' | 'schema' | 'route' | 'db' | 'type'
  description: string
  peer?: string
  file?: string
}

// Recursively collect files matching a set of extensions under a root dir
function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = []
  if (!fs.existsSync(dir)) return results
  const entries = fs.readdirSync(dir, {withFileTypes: true})
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, exts))
    } else if (exts.some(e => entry.name.endsWith(e))) {
      results.push(full)
    }
  }
  return results
}

// Return peer name derived from worktree path segment
function peerFromPath(worktreesRoot: string, filePath: string): string | undefined {
  const rel = path.relative(worktreesRoot, filePath)
  const parts = rel.split(path.sep)
  return parts[0] || undefined
}

export class ContractValidator {
  private paths: ReturnType<typeof orchPaths>

  constructor(private readonly repoRoot: string) {
    this.paths = orchPaths(repoRoot)
  }

  // -------------------------------------------------------------------
  // 1. API mismatch: fetch() calls vs openapi paths
  // -------------------------------------------------------------------
  private detectApiMismatches(): MismatchResult[] {
    const mismatches: MismatchResult[] = []
    if (!fs.existsSync(this.paths.contractApi)) return mismatches

    // Parse defined paths from OpenAPI
    let definedPaths: Set<string>
    try {
      const raw = fs.readFileSync(this.paths.contractApi, 'utf8')
      const spec = yaml.parse(raw) as {paths?: Record<string, unknown>}
      definedPaths = new Set(Object.keys(spec?.paths ?? {}))
    } catch {
      return mismatches
    }

    if (definedPaths.size === 0) return mismatches

    // Scan worktrees for fetch() calls
    const worktreesDir = this.paths.worktrees
    if (!fs.existsSync(worktreesDir)) return mismatches

    const sourceFiles = collectFiles(worktreesDir, ['.ts', '.tsx', '.js'])

    // Match: fetch(`/api/...`) fetch('/api/...') fetch("/api/...")
    // Also axios.get('/api/...') style — capture the path string
    const fetchRe = /fetch\(\s*[`'"](\/[^`'"?\s]+)/g
    const axiosRe = /\.(get|post|put|patch|delete|request)\(\s*[`'"](\/[^`'"?\s]+)/g

    for (const file of sourceFiles) {
      // Only look in src/ subtrees
      if (!file.includes(`${path.sep}src${path.sep}`)) continue

      let content: string
      try {
        content = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }

      const peer = peerFromPath(worktreesDir, file)
      const check = (endpoint: string) => {
        // Normalise: strip trailing slash, query params already excluded by regex
        const normalised = endpoint.replace(/\/$/, '')
        if (!definedPaths.has(normalised)) {
          mismatches.push({
            type: 'api',
            description: `fetch() to undefined endpoint: ${normalised}`,
            peer,
            file,
          })
        }
      }

      for (const m of content.matchAll(fetchRe)) check(m[1])
      for (const m of content.matchAll(axiosRe)) check(m[2])
    }

    return mismatches
  }

  // -------------------------------------------------------------------
  // 2. Schema mismatch: entities.schema.json vs types.ts interfaces
  // -------------------------------------------------------------------
  private detectSchemaMismatches(): MismatchResult[] {
    const mismatches: MismatchResult[] = []
    if (!fs.existsSync(this.paths.contractEntities)) return mismatches
    if (!fs.existsSync(this.paths.contractTypes)) return mismatches

    // Parse JSON Schema — top-level definitions or $defs or properties
    let schemaFields: Map<string, Set<string>> // entity -> field names
    try {
      const raw = JSON.parse(fs.readFileSync(this.paths.contractEntities, 'utf8')) as Record<string, unknown>
      schemaFields = new Map()

      const defs = (raw.$defs ?? raw.definitions ?? {}) as Record<string, {properties?: Record<string, unknown>}>
      for (const [name, def] of Object.entries(defs)) {
        if (def.properties) schemaFields.set(name, new Set(Object.keys(def.properties)))
      }
      // Also handle flat top-level properties (single-entity schema)
      if (schemaFields.size === 0 && raw.properties) {
        const title = (raw.title as string | undefined) ?? 'Entity'
        schemaFields.set(title, new Set(Object.keys(raw.properties as object)))
      }
    } catch {
      return mismatches
    }

    if (schemaFields.size === 0) return mismatches

    // Parse types.ts for interface declarations and their fields
    let typesContent: string
    try {
      typesContent = fs.readFileSync(this.paths.contractTypes, 'utf8')
    } catch {
      return mismatches
    }

    // Extract interface blocks: interface Name { ... }
    const interfaceRe = /interface\s+(\w+)\s*\{([^}]*)\}/gs
    const interfaceFields = new Map<string, Set<string>>()
    for (const m of typesContent.matchAll(interfaceRe)) {
      const name = m[1]
      const body = m[2]
      // field lines: fieldName?: or fieldName:
      const fieldRe = /^\s*(\w+)\??:/gm
      const fields = new Set<string>()
      for (const fm of body.matchAll(fieldRe)) fields.add(fm[1])
      if (fields.size > 0) interfaceFields.set(name, fields)
    }

    // Compare: for each schema entity, find matching interface and diff fields
    for (const [entity, schemaSet] of schemaFields) {
      const ifaceSet = interfaceFields.get(entity)
      if (!ifaceSet) {
        mismatches.push({
          type: 'schema',
          description: `Schema entity '${entity}' has no matching TypeScript interface in types.ts`,
          file: this.paths.contractTypes,
        })
        continue
      }

      for (const field of schemaSet) {
        if (!ifaceSet.has(field)) {
          mismatches.push({
            type: 'schema',
            description: `Entity '${entity}': field '${field}' defined in schema but missing in interface`,
            file: this.paths.contractTypes,
          })
        }
      }

      for (const field of ifaceSet) {
        if (!schemaSet.has(field)) {
          mismatches.push({
            type: 'schema',
            description: `Entity '${entity}': field '${field}' defined in interface but missing in schema`,
            file: this.paths.contractEntities,
          })
        }
      }
    }

    return mismatches
  }

  // -------------------------------------------------------------------
  // 3. Route mismatch: pages.routes.json vs filesystem routes
  // -------------------------------------------------------------------
  private detectRouteMismatches(): MismatchResult[] {
    const mismatches: MismatchResult[] = []
    if (!fs.existsSync(this.paths.contractRoutes)) return mismatches

    let contractRoutes: Set<string>
    try {
      const raw = JSON.parse(fs.readFileSync(this.paths.contractRoutes, 'utf8')) as {routes?: Array<{path: string}>}
      contractRoutes = new Set((raw.routes ?? []).map(r => r.path))
    } catch {
      return mismatches
    }

    if (contractRoutes.size === 0) return mismatches

    const worktreesDir = this.paths.worktrees
    if (!fs.existsSync(worktreesDir)) return mismatches

    // Collect route files from pages/, app/, src/pages/ directories
    const routeDirs = ['pages', 'app', 'src/pages']
    const peers = fs.readdirSync(worktreesDir, {withFileTypes: true})
      .filter(e => e.isDirectory())
      .map(e => e.name)

    // Also scan for React Router <Route path="..."> and Next.js file conventions
    const routeTagRe = /<Route[^>]+path=["'`]([^"'`]+)["'`]/g

    for (const peer of peers) {
      const worktreeRoot = path.join(worktreesDir, peer)

      // File-system based routes (Next.js / pages router)
      for (const routeDir of routeDirs) {
        const dir = path.join(worktreeRoot, routeDir)
        if (!fs.existsSync(dir)) continue
        const files = collectFiles(dir, ['.tsx', '.ts', '.jsx', '.js'])
        for (const file of files) {
          // Convert file path to route: strip dir prefix, strip extension, handle index
          let rel = path.relative(dir, file)
          rel = rel.replace(/\\/g, '/')
          rel = rel.replace(/\.(tsx|ts|jsx|js)$/, '')
          rel = rel.replace(/\/index$/, '') || '/'
          if (!rel.startsWith('/')) rel = '/' + rel
          // Skip _app, _document, api routes for this check
          if (rel.includes('/_') || rel.startsWith('/api/')) continue

          if (!contractRoutes.has(rel)) {
            mismatches.push({
              type: 'route',
              description: `Route '${rel}' found in filesystem but not in pages.routes.json`,
              peer,
              file,
            })
          }
        }
      }

      // React Router declarative routes
      const srcFiles = collectFiles(path.join(worktreeRoot, 'src'), ['.tsx', '.ts', '.jsx', '.js'])
      for (const file of srcFiles) {
        let content: string
        try {
          content = fs.readFileSync(file, 'utf8')
        } catch {
          continue
        }
        for (const m of content.matchAll(routeTagRe)) {
          const routePath = m[1]
          if (!contractRoutes.has(routePath)) {
            mismatches.push({
              type: 'route',
              description: `<Route path="${routePath}"> found in code but not in pages.routes.json`,
              peer,
              file,
            })
          }
        }
      }
    }

    return mismatches
  }

  // -------------------------------------------------------------------
  // 4. DB mismatch: db-schema.prisma models vs worktree migrations/schema
  // -------------------------------------------------------------------
  private detectDbMismatches(): MismatchResult[] {
    const mismatches: MismatchResult[] = []
    if (!fs.existsSync(this.paths.contractDb)) return mismatches

    // Extract model names from contract prisma file
    let contractModels: Set<string>
    try {
      const raw = fs.readFileSync(this.paths.contractDb, 'utf8')
      contractModels = new Set<string>()
      for (const m of raw.matchAll(/^model\s+(\w+)\s*\{/gm)) contractModels.add(m[1])
    } catch {
      return mismatches
    }

    if (contractModels.size === 0) return mismatches

    const worktreesDir = this.paths.worktrees
    if (!fs.existsSync(worktreesDir)) return mismatches

    const peers = fs.readdirSync(worktreesDir, {withFileTypes: true})
      .filter(e => e.isDirectory())
      .map(e => e.name)

    // Patterns to find model names in implementation
    // Prisma schema: model Foo {
    // SQL migration: CREATE TABLE "Foo" / CREATE TABLE Foo
    const prismaModelRe = /^model\s+(\w+)\s*\{/gm
    const sqlTableRe = /CREATE\s+TABLE\s+(?:"(\w+)"|`(\w+)`|(\w+))/gi

    for (const peer of peers) {
      const worktreeRoot = path.join(worktreesDir, peer)

      // Check schema.prisma files
      const prismaFiles = collectFiles(worktreeRoot, ['.prisma'])
      for (const file of prismaFiles) {
        // Skip the contract itself if somehow it's in the worktree
        if (file === this.paths.contractDb) continue
        let content: string
        try {
          content = fs.readFileSync(file, 'utf8')
        } catch {
          continue
        }
        for (const m of content.matchAll(prismaModelRe)) {
          const model = m[1]
          if (!contractModels.has(model)) {
            mismatches.push({
              type: 'db',
              description: `Model '${model}' found in implementation schema but not in contract db-schema.prisma`,
              peer,
              file,
            })
          }
        }
      }

      // Check SQL migration files
      const migrationDirs = ['migrations', 'prisma/migrations', 'db/migrations']
      for (const migDir of migrationDirs) {
        const dir = path.join(worktreeRoot, migDir)
        if (!fs.existsSync(dir)) continue
        const sqlFiles = collectFiles(dir, ['.sql'])
        for (const file of sqlFiles) {
          let content: string
          try {
            content = fs.readFileSync(file, 'utf8')
          } catch {
            continue
          }
          for (const m of content.matchAll(sqlTableRe)) {
            const table = m[1] ?? m[2] ?? m[3]
            if (!table) continue
            // Ignore common non-entity tables
            if (['migrations', '_prisma_migrations', 'schema_migrations'].includes(table)) continue
            if (!contractModels.has(table)) {
              mismatches.push({
                type: 'db',
                description: `Table '${table}' in SQL migration not defined in contract db-schema.prisma`,
                peer,
                file,
              })
            }
          }
        }
      }
    }

    return mismatches
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  async detectMismatches(): Promise<MismatchResult[]> {
    return [
      ...this.detectApiMismatches(),
      ...this.detectSchemaMismatches(),
      ...this.detectRouteMismatches(),
      ...this.detectDbMismatches(),
    ]
  }

  readOpenApiSpec(): string | null {
    if (!fs.existsSync(this.paths.contractApi)) return null
    return fs.readFileSync(this.paths.contractApi, 'utf8')
  }

  readRoutesSpec(): unknown | null {
    if (!fs.existsSync(this.paths.contractRoutes)) return null
    try {
      return JSON.parse(fs.readFileSync(this.paths.contractRoutes, 'utf8'))
    } catch {
      return null
    }
  }

  readEntitiesSpec(): unknown | null {
    if (!fs.existsSync(this.paths.contractEntities)) return null
    try {
      return JSON.parse(fs.readFileSync(this.paths.contractEntities, 'utf8'))
    } catch {
      return null
    }
  }

  writeIntegrationReport(
    gateResults: Record<string, string>,
    mismatches: MismatchResult[],
    fixIterations: number
  ): void {
    const lines: string[] = [
      '# Integration Report',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Gate Results',
      ...Object.entries(gateResults).map(([gate, result]) => `- ${gate}: ${result}`),
      '',
      '## Mismatches',
      mismatches.length === 0
        ? '_None detected_'
        : mismatches.map(m => `- [${m.type}] ${m.description}`).join('\n'),
      '',
      `## Fix Iterations: ${fixIterations}`,
    ]
    fs.writeFileSync(this.paths.integrationReport, lines.join('\n'))
  }
}
