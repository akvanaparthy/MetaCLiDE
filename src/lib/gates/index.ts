import {execa} from 'execa'
import type {GateResult, GateResults} from '../../types.js'

export interface GateConfig {
  lint?: string
  typecheck?: string
  test?: string
  build?: string
  e2e?: string
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

  async run(gate: keyof GateConfig): Promise<GateResult> {
    const cmd = this.config[gate]
    if (!cmd) return 'skip'

    const [bin, ...args] = cmd.split(' ')
    try {
      await execa(bin, args, {
        cwd: this.projectRoot,
        stdio: 'pipe',
        reject: true,
      })
      return 'pass'
    } catch {
      return 'fail'
    }
  }

  async runAll(): Promise<GateResults> {
    const gates: Array<keyof GateResults> = ['lint', 'typecheck', 'test', 'build', 'e2e']
    const results: Partial<GateResults> = {}

    for (const gate of gates) {
      results[gate] = await this.run(gate as keyof GateConfig)
    }

    return results as GateResults
  }

  async runAllParallel(): Promise<GateResults> {
    const gates: Array<keyof GateResults> = ['lint', 'typecheck', 'test', 'build', 'e2e']
    const promises = gates.map(async g => ({gate: g, result: await this.run(g as keyof GateConfig)}))
    const settled = await Promise.all(promises)
    const results: Partial<GateResults> = {}
    for (const {gate, result} of settled) results[gate] = result
    return results as GateResults
  }

  passed(results: GateResults, required: Array<keyof GateResults> = ['lint', 'typecheck', 'build']): boolean {
    return required.every(g => results[g] === 'pass' || results[g] === 'skip')
  }
}
