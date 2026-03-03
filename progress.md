# MetaCLiDE Progress Log

## Session: 2026-03-02

### Build & Test Status
- `npm run build` (tsc): PASSES (0 errors)
- `node bin/run.js --help`: All 11 commands registered (including hidden `interactive`)
- `metaclide` (bare): Launches interactive session with /commands
- `metaclide init`: Prompts for project name, brief, stack inline (no manual file editing)
- `metaclide init --non-interactive --name X --brief Y --stack Z`: Headless init
- `metaclide doctor`: Detects Node, git, CLI tools, keytar, env vars
- `metaclide status`: Shows contract/peer state
- keytar: Available and working on Windows

### Codebase Audit — 2026-03-02 (post-fix)
Fixed all issues from full audit:
- Removed unused imports (PeersFile, crypto, Args, findRepoRoot, getCredential)
- Fixed null-safety: `orch.readPeers()` null fallback in `run.ts` context injection
- Fixed conductor lookup: fallback to `selectedPeers[0]` + error guard
- Fixed empty API key: `.trim()` check in Claude/Kimi peer adapters
- Fixed git commit: try/catch for clean-tree case in WorktreeManager
- Fixed logs --follow: proper interval cleanup on SIGINT
- Restored interactive default command (`metaclide` → `interactive.ts` via bin/run.js routing)
- Rewrote `metaclide init` to prompt inline for project requirements

### MVP 0 — Foundation ✅ COMPLETE

#### Project Scaffold
- Created `package.json` with all dependencies:
  - `@oclif/core ^4`, `@oclif/plugin-help ^6`
  - `@anthropic-ai/claude-code ^1.0.0` (Claude Code SDK with `query()`)
  - `execa ^9`, `simple-git ^3`, `keytar ^7`, `openai ^4`, `yaml ^2`, `zod ^3`
- Created `tsconfig.json` (ESM NodeNext, strict mode, compiles to `dist/`)
- Created `bin/run.js` and `bin/dev.js` for oclif v4

#### Core Types & Schemas (`src/types.ts`, `src/lib/orch/schema.ts`)
- All shared TypeScript types: `PeerConfig`, `PeersFile`, `Task`, `PlanFile`, `PeerStatus`, `ChangeRequest`, etc.
- Zod schemas for all `.orch/` file formats with runtime validation

#### .orch Management (`src/lib/orch/`)
- `paths.ts` — path helpers for all `.orch/` files and directories
- `schema.ts` — Zod validation schemas
- `index.ts` — `OrchManager` class: read/write all `.orch/` files, `findRepoRoot()`, `requireOrch()`

#### Authentication (`src/lib/auth/`)
- `keychain.ts` — `keytar` wrapper with fallback to `~/.metaclide/credentials.json`; `storeCredential`, `getCredential`, `deleteCredential`, `listStoredAgents`
- `session.ts` — `hasExistingSession()` for OAuth tools (checks `~/.codex/auth.json`, `~/.kimi/credentials/kimi-code.json`); `detectInstalledCLIs()`; `BUILT_IN_AGENTS` registry

#### Git Worktree Management (`src/lib/git/worktree.ts`)
- `WorktreeManager`: `create()`, `remove()`, `list()`, `injectContext()`, `createIntegrationBranch()`, `mergePeerBranch()`, `tagContract()`, `commit()`, `pruneStale()`

#### Contract Management (`src/lib/contracts/`)
- `lock.ts` — `ContractLock`: `lock()`, `unlock()`, `isLocked()`, `hashContracts()`, `validatePeerAck()`
- `validation.ts` — `ContractValidator`: `detectMismatches()`, `writeIntegrationReport()`

#### Verification Gates (`src/lib/gates/index.ts`)
- `VerificationGates`: runs lint, typecheck, test, build, e2e; supports parallel and sequential modes; `passed()` helper

#### In-Process Router (`src/lib/router/index.ts`)
- `Router`: tracks usage/cost per peer/provider; budget enforcement; peer selection by capability

#### Structured Logging (`src/lib/logger/index.ts`)
- `PeerLogger`: JSONL append, read, tail, stream per-peer transcript
- `SessionLogger`: multi-peer logger factory

---

### MVP 1 — Peer Adapters ✅ COMPLETE

#### Peer Interface (`src/lib/peers/interface.ts`)
- `Peer` interface: `send()` (AsyncIterable events), `ackContract()`, `writeStatus()`, `shutdown()`

#### Claude Peer (`src/lib/peers/claude.ts`)
- `ClaudePeer`: uses `query()` from `@anthropic-ai/claude-code` SDK
- Falls back to `claude -p --output-format stream-json` subprocess if SDK unavailable
- Blocks dangerous bash commands (`git push`, `rm -rf`, `npm publish`)
- Injects MetaCLiDE context + invariants in system prompt

#### Codex Peer (`src/lib/peers/codex.ts`)
- `CodexPeer`: spawns `codex exec "<prompt>" --json --approval-policy never`
- Parses NDJSON output stream; tracks thread IDs for resumption

#### Kimi Peer (`src/lib/peers/kimi.ts`)
- `KimiPeer`: OpenAI-compatible API at `api.moonshot.cn/v1`, model `kimi-k2-thinking-turbo`
- Falls back to `kimi --print --json` CLI subprocess (OAuth mode)
- Streaming chat completions

#### Peer Factory (`src/lib/peers/factory.ts`)
- `PeerFactory.create()`: dispatches by `provider` field (anthropic/openai/moonshot)
- `PeerFactory.createAll()`: batch creation

---

### CLI Commands ✅ COMPLETE

| Command | File | Status |
|---------|------|--------|
| `metaclide` (interactive) | `src/commands/index.ts` | Done |
| `metaclide init` | `src/commands/init.ts` | Done |
| `metaclide connect` | `src/commands/connect.ts` | Done |
| `metaclide agents` | `src/commands/agents/index.ts` | Done |
| `metaclide agents add` | `src/commands/agents/add.ts` | Done |
| `metaclide agents remove` | `src/commands/agents/remove.ts` | Done |
| `metaclide run` | `src/commands/run.ts` | Done |
| `metaclide status` | `src/commands/status.ts` | Done |
| `metaclide logs` | `src/commands/logs.ts` | Done |
| `metaclide resume` | `src/commands/resume.ts` | Done |
| `metaclide export` | `src/commands/export.ts` | Done |
| `metaclide doctor` | `src/commands/doctor.ts` | Done |

#### `metaclide run` phases implemented:
1. Worktree creation + context injection
2. Phase 1: Planning (Conductor creates contracts + plan.json)
3. Phase 2: Contract Review (parallel ACK/REJECT from peers)
4. Phase 3: Lock (LOCK.contracts + git tag)
5. Phase 4: Implementation (parallel per peer)
6. Phase 5: Integration (merge + verification gates + mismatch detection)
7. Phase 6: Delivery (integration report)

---

## Architecture Summary

```
.orch/
├── brief.md                 # User requirements
├── peers.json               # Peer registry
├── plan.json                # Task graph
├── LOCK.contracts           # Contract lock file
├── contracts/               # Canonical specs (OpenAPI, routes, entities, types, db)
├── status/<peer>.json       # Per-peer live status
├── change-requests/CR-*.json # Contract change proposals
├── threads/T-*.md           # Discussion logs
├── logs/<peer>.jsonl        # Structured transcripts
└── worktrees/<peer>/        # Git worktrees
```

```
src/
├── types.ts                 # All shared types
├── commands/                # oclif commands
└── lib/
    ├── orch/                # .orch manager + schemas + paths
    ├── auth/                # keytar keychain + session detection
    ├── git/                 # WorktreeManager (simple-git)
    ├── contracts/           # ContractLock + ContractValidator
    ├── gates/               # VerificationGates (lint/typecheck/test/build)
    ├── router/              # In-process budget router
    ├── logger/              # JSONL structured logging
    └── peers/               # Peer interface + Claude/Codex/Kimi adapters + factory
```

---

## Session: 2026-03-02 (continued)

### Conductor Chat — Interactive Mode Rewrite
- Added `@anthropic-ai/sdk` dependency for direct Messages API access
- Added `@inquirer/prompts` for arrow-key selection and masked input
- Rewrote `src/commands/interactive.ts`: bare `metaclide` now opens a chat with the Conductor agent
  - Auto-inits `.orch/` if not present (no separate `metaclide init` needed)
  - Arrow-key conductor selection (Claude / Codex / Kimi with BYOK or OAuth modes)
  - OAuth session validation before proceeding
  - Resolves API key from env → keychain → masked prompt (stores to keychain)
  - Three chat backends: Anthropic SDK (Claude), OpenAI SDK (Codex/Kimi BYOK), CLI subprocess (Codex/Kimi OAuth)
  - Multi-turn conversation with tool use (save_brief, read_brief, list_files)
  - Conductor automatically writes `.orch/brief.md` when it understands the project
  - Slash commands (`/run`, `/status`, `/logs`, `/exit`) bypass conductor
- Simplified `src/commands/init.ts`: scaffold-only, no prompts
- Updated `OrchManager.init()`: optional project name param
- Added `OrchManager.readProjectName()`: extracts name from brief.md heading

### Spec Updates
- Updated `MetaCLiDE_spec_and_implementation.md`:
  - Section 3 (Tech Stack): added Ink, OAuth, provider SDKs
  - Section 4.1: full OAuth flow specs for Codex (PKCE + device code) and Kimi (device code)
  - Section 11: complete TUI spec with React + Ink component hierarchy, session persistence, slash commands
  - Section 16 (Roadmap): reordered — MVP 2 = Ink TUI, MVP 3 = OAuth, MVP 4 = N-Peer, MVP 5 = Plugins
  - Appendix A: updated npm packages

### MVP 2 — Ink TUI ✅ COMPLETE

#### Dependencies Added
- `ink` v5, `react` v18, `@types/react` v18
- `ink-text-input`, `ink-spinner`, `ink-select-input`

#### TUI Components (`src/tui/`)
- `App.tsx` — Main app state machine with 3 phases: select_conductor → enter_key → chat
- `Header.tsx` — Project name, conductor name, phase display
- `ChatHistory.tsx` — Scrollable message list
- `Message.tsx` — Role-based message rendering (user=blue, assistant=plain, tool=dim, system=italic)
- `StatusBar.tsx` — Loading indicator + hint text
- `ConductorSelect.tsx` — Arrow-key conductor picker (Claude/Codex/Kimi with OAuth/BYOK)
- `ApiKeyInput.tsx` — Masked API key input with `*` mask
- `conductor.ts` — Chat backend with streaming: Anthropic SDK, OpenAI SDK, CLI subprocess

#### Interactive Command Rewrite
- `src/commands/interactive.ts` renders Ink `<App>` component
- Auto-inits `.orch/` on first run
- Streaming responses from conductor (token-by-token for Anthropic)
- Tool use display with status transitions (tool_start → tool_done)
- Project name auto-refreshes after save_brief tool call
- Slash commands: /help, /exit, /status, /run, /logs
- Ctrl+C exits cleanly

#### Config Changes
- `tsconfig.json`: added `"jsx": "react-jsx"`, target bumped to `ES2023`

### Conductor System Prompt Fix
- Made system prompt more assertive: conductor immediately calls save_brief instead of asking for structured input
- Fixed `readProjectName()` to not return default "Project" placeholder

### MVP 3 — Native OAuth ✅ COMPLETE

#### OAuth Modules
- `src/lib/auth/oauth-codex.ts` — Codex OAuth (OpenAI)
  - PKCE browser flow: local server on :1455, PKCE S256, token exchange for `sk-...` API key
  - Device code fallback: polls `auth.openai.com/api/accounts/deviceauth/token`
  - Token storage at `~/.codex/auth.json` (mode 0o600)
  - Token refresh when `last_refresh` > 8 days
  - Exports: `loginCodexBrowser()`, `loginCodexDevice()`, `refreshCodexTokens()`, `getCodexApiKey()`, `hasCodexSession()`

- `src/lib/auth/oauth-kimi.ts` — Kimi OAuth (Moonshot)
  - Device code flow (RFC 8628) with `X-Msh-*` platform headers
  - Stable device ID generated once in `~/.metaclide/device_id`
  - Token storage at `~/.kimi/credentials/kimi-code.json` (mode 0o600)
  - Token refresh when <5 min to expiry, revocation handling (401/403 → delete tokens)
  - Exports: `loginKimiDevice()`, `refreshKimiTokens()`, `getKimiAccessToken()`, `hasKimiSession()`

#### Dependencies Added
- `open` — browser launching for OAuth flows

#### TUI Integration
- OAuth options always visible in conductor selector (not gated on CLI detection)
- Active sessions show green `●` indicator
- Selecting OAuth triggers login flow inline:
  - Codex: tries browser PKCE first, falls back to device code
  - Kimi: device code with verification URL + user code display
- OAuth progress shown in dedicated "Logging in..." phase
- On failure: returns to conductor selection with error message

---

## Remaining / TODO

### MVP 3.1 (Session Persistence)
- [ ] JSONL session persistence with resume support

### MVP 4 (N-Peer + Mismatch Detection)
- [ ] `metaclide doctor` — add `npm install` / `yarn` check
- [ ] PR export improvements (richer body with task summary)

### Known Issues / Notes
- `@anthropic-ai/claude-code` package name may change — check Anthropic's npm registry
- `keytar` requires native build tools on Windows; fallback file storage is used automatically
- `contracts/lock.ts` uses `require('node:path')` which is CJS — fix to `import` for ESM purity
- Codex CLI subprocess output format depends on `codex` version — may need adjustment
