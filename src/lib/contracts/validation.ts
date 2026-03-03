import fs from 'node:fs'
import path from 'node:path'
import {orchPaths} from '../orch/paths.js'

export interface MismatchResult {
  type: 'api' | 'schema' | 'route' | 'db' | 'type'
  description: string
  peer?: string
  file?: string
}

export class ContractValidator {
  private paths: ReturnType<typeof orchPaths>

  constructor(private readonly repoRoot: string) {
    this.paths = orchPaths(repoRoot)
  }

  async detectMismatches(): Promise<MismatchResult[]> {
    const mismatches: MismatchResult[] = []

    // Check if contract files exist
    const contractFiles = [
      {path: this.paths.contractApi, name: 'api.openapi.yaml'},
      {path: this.paths.contractRoutes, name: 'pages.routes.json'},
      {path: this.paths.contractEntities, name: 'entities.schema.json'},
    ]

    for (const {path: p, name} of contractFiles) {
      if (!fs.existsSync(p)) {
        mismatches.push({
          type: 'api',
          description: `Missing contract file: ${name}`,
          file: p,
        })
      }
    }

    // TODO: Deep validation - check that implementation files conform to contracts
    // This requires parsing OpenAPI, JSON Schema, etc.
    // For now, surface basic file existence checks

    return mismatches
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
