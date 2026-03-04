import {execa} from 'execa'
import type {GateResult, GateResults} from '../../types.js'

export interface GateConfig {
  lint?: string
  typecheck?: string
  test?: string
  build?: string
  e2e?: string
}

export interface GateRunResult {
  result: GateResult
  output: string  // combined stdout+stderr for fix prompts
}

const DEFAULTS: GateConfig = {
  lint: 'npm run lint --if-present',
  typecheck: 'npm run typecheck --if-present',
  test: 'npm test --if-present',
  build: 'npm run build --if-present',
}

export class VerificationGates {
  constructor(
    private readonly projectRoot: string,
    private readonly config: GateConfig = DEFAULTS
  ) {}

  async run(gate: keyof GateConfig): Promise<GateRunResult> {
    const cmd = this.config[gate]
    if (!cmd) return {result: 'skip', output: ''}

    // Simple shell split — handles the npm run patterns we use
    const parts = cmd.split(/\s+/)
    const [bin, ...args] = parts
    try {
      const proc = await execa(bin, args, {
        cwd: this.projectRoot,
        stdio: 'pipe',
        reject: false,
        shell: false,
      })
      const output = [proc.stdout, proc.stderr].filter(Boolean).join('\n').trim()
      const result: GateResult = proc.exitCode === 0 ? 'pass' : 'fail'
      return {result, output}
    } catch (err) {
      return {result: 'fail', output: String(err)}
    }
  }

  async runAll(): Promise<{results: GateResults; outputs: Record<string, string>}> {
    const gates: Array<keyof GateResults> = ['lint', 'typecheck', 'test', 'build', 'e2e']
    const results: Partial<GateResults> = {}
    const outputs: Record<string, string> = {}

    for (const gate of gates) {
      const {result, output} = await this.run(gate as keyof GateConfig)
      results[gate] = result
      if (output) outputs[gate] = output
    }

    return {results: results as GateResults, outputs}
  }

  async runAllParallel(): Promise<{results: GateResults; outputs: Record<string, string>}> {
    const gates: Array<keyof GateResults> = ['lint', 'typecheck', 'test', 'build', 'e2e']
    const settled = await Promise.all(gates.map(async g => ({gate: g, ...(await this.run(g as keyof GateConfig))})))
    const results: Partial<GateResults> = {}
    const outputs: Record<string, string> = {}
    for (const {gate, result, output} of settled) {
      results[gate] = result
      if (output) outputs[gate] = output
    }
    return {results: results as GateResults, outputs}
  }

  passed(results: GateResults, required: Array<keyof GateResults> = ['lint', 'typecheck', 'build']): boolean {
    return required.every(g => results[g] === 'pass' || results[g] === 'skip')
  }
}
