# MetaCLiDE — Project Specification & Implementation Guide v2.0

*A terminal-first CLI that orchestrates any combination of AI coding agents as a collaborative peer team on a single project.*

*March 2026 · Spec + verified implementation details for any coding agent building this project*

---

## 1. What Is This?

MetaCLiDE is a TypeScript-based CLI that orchestrates any number of AI coding-agent tools so they collaborate on a single codebase like a team of human developers. The user selects which agents to work with — any combination of 2 or more — and those agents self-organize as peers.

Built-in supported agents (out of the box): **Claude Code**, **Codex CLI**, and **Kimi Code CLI**. Any additional OpenAI-compatible API provider or CLI-based coding agent can be added via the plugin registry.

The user provides a project idea, requirements, and tech stack. MetaCLiDE connects to the user's selected agents (via OAuth or BYOK API keys), assigns a Conductor, and the peers self-organize: they discuss, split work, implement in parallel, share locked contracts, and integrate — delivering a working project.

### 1.1 The Core Problem

- Users pay for multiple AI coding subscriptions but use them one at a time, switching manually.
- Each subscription has limited usage; tokens are wasted on redundant context or wrong-tool-for-the-job tasks.
- No existing product lets these tools talk to each other and build together.

### 1.2 What Makes This Different

MetaCLiDE is not an agent framework or a model router. It orchestrates full coding-agent products as autonomous peers — each with their own reasoning, tool use, and sub-agent capabilities — and makes them collaborate through a contract-first protocol that prevents the oscillation problem where agents endlessly revise each other's work.

The peer count is not fixed. A session can be:
- **2 peers** — minimum viable collaboration (e.g. Claude + Codex)
- **3 peers** — the default recommended setup
- **4+ peers** — for large projects, or when the user has multiple subscriptions
- **All one provider** — e.g. two Codex instances with different specializations
- **Mixed OAuth + BYOK** — some peers using subscriptions, others using API keys

---

## 2. Goals

1. Let users connect any combination of coding-agent subscriptions in one place.
2. Support 2 or more peers per session — user selects which agents participate.
3. Agents self-organize: discuss, assign, and execute tasks collaboratively.
4. Optimize token usage across subscriptions by routing work to the best-fit agent.
5. Deliver a verified, integrated, working project — not just code fragments.
6. Zero extra setup: no proxy servers, no environment variable juggling, no config files to write.
7. Extensible: new agents can be added via the plugin registry without changing core code.

### 2.1 Success Criteria

- User selects 2+ agents and inputs a single prompt for a full-stack app; receives a runnable project.
- Multiple peers generate non-conflicting code that compiles on first integration attempt >80% of the time.
- No oscillation: peers never enter infinite loops of mutual modification.
- Token efficiency: utilizes multiple subscriptions optimally without manual switching.
- Any OpenAI-compatible provider can be registered as a new peer type in < 50 lines of code.

---

## 3. Technology Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Language | TypeScript (Node.js) | Same ecosystem as Codex/Claude Code CLIs; strong typing |
| CLI Framework | oclif | Subcommands, plugins, auto-updates, cross-platform builds |
| Terminal UI | React + Ink v5 | Declarative component model; Claude Code-style experience |
| Process Control | execa | Non-interactive agent subprocesses |
| Git Operations | simple-git | Worktree management, branching, merging |
| Config/Schema | Zod + YAML | Validated config; human-readable project files |
| Contract Validation | OpenAPI 3.0, JSON Schema, Zod | Validate code against contracts, not just "does it build" |
| Key Storage | OS keychain (keytar) | Secure BYOK key storage; no plaintext files |
| Auth (OAuth) | Device code + PKCE | RFC 8628 device flow for Codex/Kimi; PKCE browser flow for Codex |
| Provider SDKs | @anthropic-ai/sdk, openai | Direct Messages API for Claude; OpenAI-compatible for Codex/Kimi |
| Logging | JSONL files | Structured, per-agent transcripts |
| Testing | Vitest | Fast TS-native test runner |
| Packaging | pkg or oclif pack | Single binary for Windows + macOS |

### 3.1 Router (In-Process, No Proxy)

All model routing, budget enforcement, fallback logic, and request tagging happen inside the MetaCLiDE process. No LiteLLM, no local server, no extra dependencies. The Router module exposes an OpenAI-compatible interface internally and maps requests to the correct provider SDK.

### 3.2 Target Platforms

- Windows + macOS first.
- Linux later.

---

## 4. Authentication Model

### 4.1 Primary: OAuth to Coding-Agent Tools (Tool-Backed Mode)

MetaCLiDE implements OAuth flows natively — no shelling out to `codex login` or `kimi login`. The user authenticates directly inside MetaCLiDE, and tokens are managed (stored, refreshed, rotated) by MetaCLiDE's auth module.

> **Note on Claude Code:** Anthropic's Terms of Service restrict OAuth tokens from Free/Pro/Max plans to Claude Code and Claude.ai only. Third-party tools must use API key authentication. Claude is therefore always API-backed (BYOK). Codex and Kimi Code OAuth flows are unaffected.

#### 4.1.1 Codex OAuth (OpenAI)

Two flows supported:

**Flow A: PKCE Browser Flow (Primary)**

| Parameter | Value |
|-----------|-------|
| Client ID | `app_EMoamEEZ73f0CkXaXp7hrann` |
| Auth host | `https://auth.openai.com` |
| Callback port | `1455` (localhost) |
| Scopes | `openid profile email offline_access` |

Steps:
1. Generate PKCE `code_verifier` (64 random bytes → URL-safe base64) and `code_challenge` (SHA-256 of verifier → URL-safe base64)
2. Start local HTTP server on `http://localhost:1455`
3. Open browser to `https://auth.openai.com/oauth/authorize?response_type=code&client_id=...&redirect_uri=http://localhost:1455/auth/callback&scope=...&code_challenge=...&code_challenge_method=S256&state=...`
4. Receive callback at `/auth/callback?code=...&state=...`, validate state
5. Exchange auth code for tokens: `POST https://auth.openai.com/oauth/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`
6. Exchange `id_token` for API key: `POST https://auth.openai.com/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `requested_token=openai-api-key`, `subject_token={id_token}`, `subject_token_type=urn:ietf:params:oauth:token-type:id_token`
7. Store to `~/.codex/auth.json`

**Flow B: Device Code Flow (Headless Fallback)**

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode` → get `device_auth_id`, `user_code`
2. Display: "Go to https://auth.openai.com/codex/device and enter code: ABCD-EFGH"
3. Poll `POST https://auth.openai.com/api/accounts/deviceauth/token` every 5s (max 15 min)
4. On 200: receive `authorization_code` + `code_verifier` → exchange for tokens (same as Step 5–6 above, with `redirect_uri=https://auth.openai.com/deviceauth/callback`)
5. Store to `~/.codex/auth.json`

**Token storage** (`~/.codex/auth.json`):
```json
{
  "auth_mode": "chatgpt",
  "openai_api_key": "sk-...",
  "tokens": {
    "id_token": "eyJ...",
    "access_token": "eyJ...",
    "refresh_token": "eyJ..."
  },
  "last_refresh": "2026-03-02T12:00:00Z"
}
```

**Token refresh**: `POST https://auth.openai.com/oauth/token` with `grant_type=refresh_token`. Trigger when `last_refresh` > 8 days old.

#### 4.1.2 Kimi OAuth (Moonshot AI)

Device code flow only (RFC 8628).

| Parameter | Value |
|-----------|-------|
| Client ID | `17e5f671-d194-4dfb-9706-5516cb48c098` |
| Auth host | `https://auth.kimi.com` |

**Required headers on all requests:**
```
X-Msh-Platform: metaclide
X-Msh-Version: <metaclide_version>
X-Msh-Device-Name: <os.hostname()>
X-Msh-Device-Model: <os.arch()>
X-Msh-Os-Version: <os.version()>
X-Msh-Device-Id: <stable_uuid_hex>  (generated once, stored in ~/.metaclide/device_id)
```

Steps:
1. `POST https://auth.kimi.com/api/oauth/device_authorization` with `client_id` → get `user_code`, `device_code`, `verification_uri_complete`, `interval`
2. Open browser to `verification_uri_complete`. Display user code in terminal.
3. Poll `POST https://auth.kimi.com/api/oauth/token` with `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds
4. On 200: receive `access_token`, `refresh_token`, `expires_in`
5. Store to `~/.kimi/credentials/kimi-code.json`

**Token storage** (`~/.kimi/credentials/kimi-code.json`):
```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_at": 1709395200,
  "scope": "...",
  "token_type": "Bearer"
}
```

**Token refresh**: `POST https://auth.kimi.com/api/oauth/token` with `grant_type=refresh_token`. Background check every 60s; refresh when <5 min to expiry. On 401/403: tokens revoked, user must re-login.

Custom/plugin agents that support OAuth follow the same pattern — MetaCLiDE stores their token in the OS keychain under `metaclide/<agent-id>` and injects it as the appropriate env var.

### 4.2 Secondary: BYOK (Bring Your Own Key)

User provides API keys directly. Keys are stored in the OS keychain. MetaCLiDE uses provider SDKs to call models directly (no subprocess, no PTY). User selects provider(s) and model(s) from a list. Supports multiple keys with per-provider budget caps.

Built-in BYOK providers:

| Provider | Env Var | API Base URL | Notes |
|----------|---------|--------------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` | Required for Claude; only auth option |
| OpenAI | `CODEX_API_KEY` or `OPENAI_API_KEY` | `https://api.openai.com/v1` | Fallback if no Codex CLI session |
| Moonshot AI | `MOONSHOT_API_KEY` | `https://api.moonshot.cn/v1` | OpenAI-compatible endpoint |

Any additional OpenAI-compatible provider (e.g. Groq, Together AI, Ollama, DeepSeek) can be registered via the plugin registry — MetaCLiDE will treat it as a BYOK API peer using the standard `openai` npm SDK with a custom `baseURL`.

### 4.3 Auth Flow

On first run (or via `metaclide connect`), MetaCLiDE walks the user through selecting and connecting agents:

1. **Select agents** — user picks which agents to use in this session (2 or more). Can be any combination of built-in or plugin agents.
2. **Pick connection method per agent** — OAuth (for tools that support it) or BYOK API key.
3. **OAuth agents** — MetaCLiDE detects existing CLI sessions first. If not found, triggers the tool's login flow (device-code where available, otherwise browser redirect).
4. **BYOK agents** — user pastes API key, selects model from a list for that provider.
5. **Validation** — MetaCLiDE runs a small test call per agent to confirm the connection works.
6. **Storage** — credentials saved in OS keychain via `keytar` under `metaclide/<agent-id>`. No re-login needed unless revoked.

The set of connected agents is stored in `.orch/peers.json` (see Section 5). The user can add, remove, or swap agents at any time via `metaclide connect`.

### 4.4 Session Detection Logic

MetaCLiDE checks for existing local CLI sessions before prompting for login. Each built-in agent has a known session file path. Plugin agents declare their session file in the plugin manifest.

```typescript
// src/auth/detectSession.ts
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// Built-in session file locations per CLI agent
const SESSION_FILES: Record<string, string> = {
  codex: path.join(homedir(), '.codex', 'auth.json'),
  kimi:  path.join(homedir(), '.kimi', 'credentials', 'kimi-code.json'),
  // Plugin agents register their session file in peers.json under sessionFile
};

export function hasExistingSession(agentId: string, customSessionFile?: string): boolean {
  const sessionFile = customSessionFile ?? SESSION_FILES[agentId];
  return sessionFile ? existsSync(sessionFile) : false;
}

// Retrieve any stored credential from the OS keychain
export async function getCredential(agentId: string): Promise<string | null> {
  const keytar = await import('keytar');
  return keytar.getPassword('metaclide', agentId);
}

export async function storeCredential(agentId: string, value: string): Promise<void> {
  const keytar = await import('keytar');
  await keytar.setPassword('metaclide', agentId, value);
}
```

---

## 5. Repository Layout

All shared state lives inside the repo:

```
.orch/
├── brief.md                        # User requirements (prompt + stack)
├── peers.json                      # Active peer registry for this session
├── plan.json                       # Task graph: tasks, owners, deps, status
├── LOCK.contracts                  # Lock file owned by conductor session
│
├── contracts/
│   ├── VERSION                     # Integer version (1, 2, 3...)
│   ├── api.openapi.yaml            # OpenAPI 3.0 spec: endpoints, methods, schemas
│   ├── pages.routes.json           # Frontend route map: path → component → endpoint
│   ├── entities.schema.json        # Shared entity/data models (JSON Schema)
│   ├── types.ts                    # Shared TypeScript interfaces
│   ├── db-schema.prisma            # Database schema (Prisma or SQL)
│   └── decisions.md                # Architecture Decision Records (ADR-style)
│
├── status/
│   └── <peer-id>.json              # One file per active peer (dynamic, not fixed)
│
├── change-requests/
│   └── CR-<id>.json
│
├── threads/
│   └── T-<id>.md                   # Human-readable discussion logs
│
├── logs/
│   └── <peer-id>.jsonl             # Structured per-agent transcripts (one per peer)
│
├── integration-report.md           # Final integration summary
│
└── worktrees/
    └── <peer-id>/                  # One git worktree per active peer (dynamic)
```

### 5.1 Peer Registry (peers.json)

This file is written by MetaCLiDE when the user selects agents for a session. It is the runtime record of who is participating. The peer list is not hardcoded anywhere — all orchestration logic reads from this file.

```json
{
  "conductor": "codex",
  "peers": [
    {
      "id": "codex",
      "displayName": "Codex CLI",
      "type": "tool",
      "provider": "openai",
      "mode": "oauth",
      "sessionFile": "~/.codex/auth.json",
      "contextFile": "AGENTS.md",
      "branch": "agent/codex",
      "role": "conductor"
    },
    {
      "id": "claude",
      "displayName": "Claude Code",
      "type": "api",
      "provider": "anthropic",
      "mode": "byok",
      "model": "claude-opus-4-5",
      "contextFile": "CLAUDE.md",
      "branch": "agent/claude",
      "role": "implementer"
    },
    {
      "id": "kimi",
      "displayName": "Kimi Code",
      "type": "tool",
      "provider": "moonshot",
      "mode": "oauth",
      "sessionFile": "~/.kimi/credentials/kimi-code.json",
      "contextFile": "AGENTS.md",
      "branch": "agent/kimi",
      "role": "implementer"
    }
  ]
}
```

A 2-peer session would have exactly 2 entries. A 4-peer session would have 4. Adding a custom agent via the plugin registry adds a new entry with `"type": "plugin"`.

### 5.2 Canonical Contracts

These files are the truth. Implementation must conform to them:

| Contract File | What It Defines |
|---------------|-----------------|
| `api.openapi.yaml` | Endpoints, methods, request/response schemas |
| `pages.routes.json` | Frontend routes, components, connected endpoints |
| `entities.schema.json` | Shared data models, field types, relationships |
| `types.ts` | Shared TypeScript interfaces across peers |
| `db-schema.prisma` | Database tables, fields, relations |
| `decisions.md` | "Why" for naming and architecture choices |

### 5.3 Per-Peer Status File

Each peer writes only to its own status file at `.orch/status/<peer-id>.json`. The orchestrator reads all present status files to build the full picture. The set of status files always matches the peers listed in `peers.json`.

```json
{
  "peer": "codex",
  "contractVersion": 1,
  "contractHash": "a1b2c3d4",
  "activeTasks": ["task-001", "task-003"],
  "blockedBy": null,
  "lastCommit": "e5f6a7b8",
  "branch": "agent/codex",
  "lastGateResult": { "lint": "pass", "typecheck": "pass", "build": "fail" },
  "notes": "Waiting on CR-002 resolution for /admin/users endpoint"
}
```

---

## 6. How Agents Collaborate

### 6.1 The Peer Model

Each coding tool is treated as an autonomous peer — like a human developer on a team. The number of peers is determined by the user at session start (minimum 2, no maximum). Peers can:

- Discuss requirements and propose task splits in a shared discussion thread.
- Self-assign work based on their strengths and the Conductor's recommendations.
- Create their own sub-agents if they choose to.
- Read shared state and write only to their own status file.
- Raise change requests if they hit a gap in the contract.

**The discussion phase is real:** before any code is written, all active peers receive the brief and hold a structured conversation — mediated by MetaCLiDE — where they agree on roles, flag concerns, and propose the task split. The Conductor captures the outcome in `plan.json`. This works with 2 peers, 3 peers, or more; the discussion naturally scales with the number of participants.

### 6.2 The Conductor

The user selects one agent as the Conductor (or MetaCLiDE picks the strongest available model by default). The Conductor is responsible for:

- Leading the initial discussion and drafting contracts from the outcome.
- Collecting review/amendment proposals from all other peers.
- Resolving conflicts and locking the contract.
- Owning `LOCK.contracts` to enforce write exclusivity.
- Assigning tasks in `plan.json` based on the discussion outcome.
- Coordinating integration and running final verification.

The Conductor is the single source of truth. No peer can unilaterally change the contract. Any peer — including the Conductor itself — can be replaced by a different agent between sessions without changing the protocol.

### 6.3 Interface Ownership

With N peers, ownership of contract areas is assigned based on task role, not agent identity:

- The peer assigned the backend implementation task owns API contract details.
- The peer assigned the frontend task owns routing contract details.
- The Conductor owns entity schemas, shared types, and DB schema.
- With 2 peers: one peer may own multiple areas (e.g. backend + DB schema).
- With 4+ peers: ownership can be split more granularly (e.g. one peer per service).

When a CR touches an owned area, the Conductor consults the owner before resolving.

---

## 7. The Contract-First Protocol

### 7.1 Why Contracts + Locks

Without a single source of truth, peers drift. Frontend uses `/getAllUsers`, backend implements `/users`, then both "fix" by changing their own plan — creating an infinite oscillation loop.

The solution has three parts: canonical contracts (authoritative files), freeze phases (don't change contracts during parallel work), and change requests (proposals only, Conductor decides).

### 7.2 Contract ACK Handshake

Before coding, each peer must acknowledge the current contract version:

1. Read `.orch/contracts/VERSION`.
2. Compute a hash of `.orch/contracts/`.
3. Write ACK (`contractVersion` + `contractHash`) to `.orch/status/<peer>.json`.
4. If version changes mid-run, peer stops and re-syncs before continuing.

MetaCLiDE will not send implementation tasks to a peer that hasn't ACK'd the current contract version.

### 7.3 Contract Review: ACK/REJECT Protocol

During contract review, each peer responds to the draft with one of:

- **ACK** — Accept contract as-is. Peer is ready to implement.
- **REJECT** — File an objection with specific concerns. Conductor revises.

Review continues until all peers ACK or the Conductor resolves remaining objections after a configurable timeout (prevents deadlock). The Conductor then locks the contract.

### 7.4 Workflow Phases

```
Phase 1: Planning        → Conductor drafts contracts
Phase 2: Contract Review  → Peers ACK/REJECT, Conductor revises until consensus
Phase 3: Contract Lock    → Git tag (contract-v1), LOCK.contracts written
Phase 4: Implementation   → Parallel work in worktrees, contract is READ-ONLY
Phase 5: Integration      → Merge, gates, mismatch detection, fix loop
Phase 6: Delivery         → Final output to user
```

If CRs are accepted during Phase 4:

```
Phase 4a: CR Filed        → Conductor evaluates
Phase 4b: Consensus Pause → All peers halt
Phase 4c: Contract v1.1   → Conductor amends, bumps VERSION, all peers re-ACK
Phase 4d: Resume          → Peers adjust implementation, continue
```

### 7.5 Consensus Pause

When a peer files a CR during implementation, MetaCLiDE halts all peers — not just the one that filed it. This prevents other peers from continuing to build against a contract that might change. Once the Conductor resolves the CR, all peers re-ACK and resume.

### 7.6 Contract Lock Enforcement

Two mechanisms working together:

- **`LOCK.contracts` file:** Owned by Conductor session. MetaCLiDE rejects writes from non-Conductor peers to any file in `contracts/`.
- **Git tag:** Each locked contract version is tagged (`contract-v1`, `contract-v1.1`). Peers can always diff what changed between versions.

### 7.7 Change Request Protocol

| Step | Actor | Action |
|------|-------|--------|
| 1 | Peer | Creates `.orch/change-requests/CR-<id>.json` with: what, why, proposed change, impact |
| 2 | MetaCLiDE | Halts all peers (consensus pause) |
| 3 | Conductor | Reviews CR, checks impact, consults interface owner if applicable |
| 4 | Conductor | Accepts (updates contract atomically, bumps VERSION) or Rejects (with reason) |
| 5 | MetaCLiDE | Notifies all peers of resolution; peers re-ACK new version |
| 6 | Peers | Adjust implementation to match updated contract and resume |

CR schema:

```json
{
  "id": "CR-001",
  "from": "kimi",
  "status": "pending",
  "what": "Add GET /api/admin/users endpoint",
  "why": "Admin dashboard needs separate user list with role info",
  "proposed_change": "Add endpoint to api.openapi.yaml under /admin paths",
  "impact": ["frontend must add admin users page", "backend must implement endpoint"],
  "conductor_resolution": null,
  "resolved_at": null
}
```

---

## 8. Repository and Git Strategy

### 8.1 Worktree Isolation

Each peer works in an isolated git worktree. The worktrees are created dynamically based on `peers.json` at session start:

- `.orch/worktrees/<peer-id>/` → branch: `agent/<peer-id>`

With 2 peers there are 2 worktrees. With 4 peers there are 4. The integration branch (`main` or `integration`) is managed exclusively by the Conductor during Phase 5. Peers never push directly to it. Requires Git 2.5+.

### 8.2 Worktree Lifecycle (Implementation)

MetaCLiDE manages worktrees via `simple-git`. Each worktree is created before the peer's session starts, gets context files injected, and is cleaned up after integration.

```typescript
// src/git/WorktreeManager.ts
import simpleGit from 'simple-git';
import { writeFileSync, symlinkSync, existsSync } from 'fs';
import path from 'path';

export class WorktreeManager {
  private git = simpleGit(this.repoRoot);

  constructor(private repoRoot: string) {}

  // peer is any string id from peers.json — not limited to built-in names
  async create(peer: string): Promise<string> {
    const branch = `agent/${peer}`;
    const worktreePath = path.join(this.repoRoot, '.orch', 'worktrees', peer);
    await this.git.raw(['worktree', 'add', '-b', branch, worktreePath, 'main']);
    await this.injectContext(peer, worktreePath);
    return worktreePath;
  }

  // contextFile comes from peers.json entry (e.g. CLAUDE.md, AGENTS.md, or custom)
  async injectContext(peer: string, worktreePath: string, task?: Task): Promise<void> {
    const ctx = this.buildContextMarkdown(peer, task);
    const peerConfig = this.peersRegistry.get(peer);
    const contextFilename = peerConfig?.contextFile ?? 'AGENTS.md'; // default to AGENTS.md
    writeFileSync(path.join(worktreePath, contextFilename), ctx);

    // Symlink .orch so agents can read contracts without extra flags
    const orchLink = path.join(worktreePath, '.orch');
    if (!existsSync(orchLink)) {
      symlinkSync(path.join(this.repoRoot, '.orch'), orchLink);
    }
  }

  async integrate(peer: string): Promise<void> {
    const branch = `agent/${peer}`;
    await this.git.checkout('integration');
    await this.git.merge([branch]);
  }

  async remove(peer: string): Promise<void> {
    const worktreePath = path.join(this.repoRoot, '.orch', 'worktrees', peer);
    await this.git.raw(['worktree', 'remove', '--force', worktreePath]);
  }

  private buildContextMarkdown(peer: string, task?: Task): string {
    // Read current plan.json and active tasks to build the context string
    // injected into CLAUDE.md / AGENTS.md before each agent session
    return `# MetaCLiDE Agent Context\n\n## Your role\nYou are the ${peer} peer.\n\n## Active task\n${task?.description ?? 'See .orch/plan.json'}\n\n## Rules\n- Do NOT modify .orch/contracts/*\n- Write status updates to .orch/status/${peer}.json\n- File CRs to .orch/change-requests/ if contracts are insufficient\n`;
  }
}
```

### 8.3 Merge Flow

1. Conductor merges base-layer branch first (typically backend/API).
2. Conductor merges frontend branch, resolving conflicts against the contract.
3. Conductor merges any remaining peer branches.
4. Verification gates + mismatch detectors run on the merged result.
5. If gates fail: targeted Fix Tasks, peers fix on their branches, re-merge.

### 8.4 Contract Versioning in Git

Each locked contract version is tagged:

- `contract-v1` after initial lock.
- `contract-v1.1` after CR acceptance.
- Peers can always run `git diff contract-v1 contract-v1.1 -- .orch/contracts/` to see exactly what changed.

---

## 9. Integration and Validation

### 9.1 Verification Gates

| Gate | What It Checks | Failure Action |
|------|---------------|----------------|
| Lint | ESLint / Prettier compliance | Fix Task to responsible peer |
| Typecheck | `tsc --noEmit` passes | Fix Task to responsible peer |
| Unit Tests | vitest / jest pass | Fix Task with failing test logs |
| Build | `next build` / `tsc build` succeeds | Fix Task with build error logs |
| E2E Smoke (optional) | Playwright / Cypress basic flows | Fix Task with screenshots/logs |

### 9.2 Mismatch Detectors

These run after merge, separately from build gates. They check code against the contract, not just whether it compiles:

| Detector | What It Catches |
|----------|----------------|
| API Mismatch | Frontend calls an endpoint not defined in `api.openapi.yaml` |
| Schema Mismatch | TypeScript types in implementation differ from `entities.schema.json` |
| Route Mismatch | UI routes referenced in code but not defined in `pages.routes.json` |
| DB Mismatch | Prisma migrations don't match `db-schema.prisma` contract |

When a mismatch is detected:

1. MetaCLiDE auto-generates a CR describing the mismatch.
2. Conductor decides once (accept change to contract, or reject and peer must fix code).
3. If accepted: contract bumps version, peers re-ACK.
4. Assigned peer patches code to match.

### 9.3 Fix Loop

Gate failure → extract error → create Fix Task with logs → assign to responsible peer → peer fixes → re-run gates. Bounded by max 5 iterations or budget cap.

---

## 10. Routing and Budget Enforcement

### 10.1 In-Process Router

The Router module handles all model calls internally:

- **Provider routing:** direct each task to the right provider/model based on agent assignment.
- **Fallback:** if a provider errors or hits a rate limit, retry with an alternative.
- **Budget caps:** per-provider, per-agent, per-phase, and per-session spending limits.
- **Request tagging:** every request tagged with agent ID + phase + task ID for observability.

### 10.2 Routing Strategy

| Phase | Routing Rule |
|-------|-------------|
| Planning | Use strongest reasoning model |
| Implementation | Route by capability: frontend-strong model for frontend, etc. |
| Review / Debug | Use strongest model, but only on diffs + failing logs (minimize tokens) |
| Fix Tasks | Route to the peer that owns the failing code |

### 10.3 Budget Model

For BYOK/API-backed peers (accurate enforcement):

| Budget Type | Example | Enforcement |
|-------------|---------|-------------|
| Per provider / day | $5.00 OpenAI, $3.00 Anthropic | Hard cap; agent paused when exceeded |
| Per agent / session | 2000 output tokens for Planner | Soft cap; warning then pause |
| Per phase | Planning: max $1.00 total | Hard cap across all agents in phase |

For OAuth/tool-backed peers (approximate enforcement):

| Budget Proxy | What It Controls |
|--------------|-----------------|
| Max iterations per phase | Prevents runaway retries |
| Max message length sent | Limits context window usage |
| Timeouts per task | Hard stop on long-running tasks |
| User-defined heuristic cap | "Stop after N messages to this tool" |

### 10.4 Retry Policy

Bounded retries with exponential backoff. Stop conditions: budget exceeded, max iterations reached, or same error repeated 3 times (escalate to user).

---

## 11. CLI User Experience

### 11.1 Terminal UI Architecture (React + Ink)

MetaCLiDE's interactive mode uses **React + Ink v5** for a Claude Code-style terminal experience. The UI stays in the normal terminal flow (no alternate screen buffer) to preserve native scrollback, text selection, and search.

**Component hierarchy:**
```
<App>
  <Header />                    — project name, conductor info, phase
  <ChatHistory>                 — scrollable message history
    <Message role="user" />     — user input (dimmed after send)
    <Message role="assistant" /> — conductor streaming response (markdown rendered)
    <ToolUseBlock />            — tool calls with status spinner
  </ChatHistory>
  <InputField />                — multi-line input with Shift+Enter
  <StatusBar />                 — connected agents, token usage, phase, slash commands hint
</App>
```

**Key behaviors:**
- **Streaming output**: Conductor responses render token-by-token as they arrive
- **Markdown rendering**: Code blocks with syntax highlighting, inline code, bold/italic, lists
- **Tool use display**: Shows `[saving brief...]` → `[saved brief: Project Name]` with spinner
- **No alternate screen**: All output appends to normal terminal flow
- **Responsive layout**: Adapts to terminal width via Yoga flexbox (Ink built-in)

**Dependencies:**
```
ink v5               — React renderer for terminals
ink-text-input       — text input component
ink-spinner          — loading spinners
ink-select-input     — arrow-key selection menus
cli-markdown         — markdown-to-ANSI rendering
```

### 11.2 Interactive Chat (Default Mode)

Running `metaclide` with no arguments opens the Ink-based interactive session:

1. **Conductor selection** — arrow-key menu to pick Claude / Codex / Kimi (with OAuth or API key)
2. **Auth resolution** — API key from env/keychain/masked prompt, or OAuth device code flow
3. **Chat loop** — multi-turn conversation with the conductor agent
4. **Slash commands** — handled locally, bypass the conductor:

| Command | Action |
|---------|--------|
| `/run` | Start multi-agent session |
| `/status` | Show phase, tasks, budgets |
| `/logs` | View per-agent transcripts |
| `/connect` | Add/manage agent connections |
| `/sessions` | List/resume past sessions |
| `/new` | Start fresh session |
| `/compact` | Compress conversation context |
| `/help` | Show available commands |
| `/exit` | Quit |

### 11.3 Session Persistence

Sessions are stored as JSONL files with resume support:

```
~/.metaclide/sessions/
  └── <workspace-hash>/
      └── <session-uuid>/
          ├── context.jsonl     — conversation history (append-only)
          ├── wire.jsonl        — tool call/result log
          └── state.json        — session metadata (conductor, phase, timestamp)
```

- `/sessions` — list all sessions for current workspace, switch between them
- `metaclide --continue` — resume last session
- `metaclide --session <id>` — resume specific session
- Sessions auto-title from first user message

### 11.4 Non-Interactive Mode (CI/Scripts)

```bash
metaclide run --non-interactive --agents claude,codex --budget anthropic=3 openai=5
metaclide run --non-interactive --agents all
```

### 11.5 Subcommands

| Command | Description |
|---------|-------------|
| `metaclide` | Opens interactive Ink TUI session (default) |
| `metaclide init` | Scaffold `.orch/` directory |
| `metaclide connect` | Add/manage agent connections (OAuth or BYOK) |
| `metaclide agents` | List all connected agents and their status |
| `metaclide agents add` | Add a new agent interactively |
| `metaclide agents remove <id>` | Remove an agent |
| `metaclide run [--agents <ids>]` | Execute pipeline non-interactively |
| `metaclide status` | Show current phase, tasks, budgets |
| `metaclide logs [--agent <id>] [--follow]` | View per-agent transcripts |
| `metaclide resume` | Continue after failure or pause |
| `metaclide export [--patch \| --pr]` | Export as zip, patch, or GitHub PR |
| `metaclide doctor` | Check dependencies and connections |

---

## 12. Peer Adapter Interface

Every coding tool is wrapped in a unified `Peer` interface. There are two modes of operation. Which one is used depends on what the user has set up.

### 12.1 Tool-Backed Peer (OAuth/CLI Mode)

MetaCLiDE spawns the coding tool as a subprocess via its official non-interactive CLI command. It sends structured prompts, reads JSONL/text output, and parses responses. This preserves the tool's full capabilities: sub-agent creation, tool use, file editing, command execution.

**Subprocess approach per agent:**

| Agent | Command | Output format | Session resumption |
|-------|---------|---------------|--------------------|
| Claude Code | `claude -p "<prompt>" --output-format stream-json` | NDJSON stream | `--resume <session_id>` |
| Codex | `codex exec "<prompt>" --json` | NDJSON stream | `codex exec resume <thread_id>` |
| Kimi Code | `kimi --print -y -p "<prompt>"` | Text / NDJSON | Session file in `~/.kimi/` |

> **Do not use node-pty for Claude Code or Codex** — both have proper non-interactive modes that write structured output to stdout without needing a TTY. Use `execa` for these. `node-pty` is only needed if you display a live interactive terminal to the user.

### 12.2 API-Backed Peer (BYOK Mode)

MetaCLiDE calls the provider's API directly via SDK. Simpler, more controllable, fully budgetable.

**SDK per provider:**

| Provider | npm package | Notes |
|----------|-------------|-------|
| Anthropic (Claude) | `@anthropic-ai/claude-agent-sdk` | Full agent loop, tool use, file editing |
| OpenAI (Codex) | `@openai/codex-sdk` | Wraps codex exec; requires CLI installed |
| Moonshot AI (Kimi) | `openai` (standard SDK) | OpenAI-compatible endpoint at `api.moonshot.cn/v1` |

### 12.3 Common Interface

```typescript
// src/peers/Peer.ts
export interface Peer {
  id: string;
  mode: 'tool' | 'api';
  role: 'conductor' | 'implementer';

  capabilities(): Capability[];
  send(msg: PeerMessage): AsyncIterable<PeerEvent>;

  readState(path: string): Promise<string>;
  writeStatus(update: PeerStatusUpdate): Promise<void>;
  ackContract(version: number, hash: string): Promise<void>;

  shutdown(): Promise<void>;
}

interface PeerStatusUpdate {
  activeTasks: string[];
  blockedBy: string | null;
  lastCommit: string;
  lastGateResult: Record<string, 'pass' | 'fail'>;
  notes: string;
}

interface PeerMessage {
  type: 'plan' | 'review' | 'implement' | 'fix' | 'integrate' | 'discuss';
  taskId?: string;
  content: string;
  attachments?: { path: string; content: string }[];
}

interface PeerEvent {
  type: 'text' | 'file_write' | 'command' | 'status_update' | 'cr_filed' | 'done' | 'error';
  data: unknown;
}
```

### 12.4 Peer Factory

The factory reads `peers.json` and instantiates the right adapter for each peer. Built-in types are handled inline; plugin types are loaded from the plugin registry. This is how any new agent gets added without touching core orchestration code.

```typescript
// src/peers/PeerFactory.ts
import { loadPlugin } from '../plugins/registry';

export async function createPeer(config: PeerConfig): Promise<Peer> {
  // Plugin agents: loaded dynamically from ~/.metaclide/plugins/
  if (config.type === 'plugin') {
    const plugin = await loadPlugin(config.pluginId);
    return plugin.createPeer(config);
  }

  // Built-in API peers (BYOK)
  if (config.mode === 'byok') {
    switch (config.provider) {
      case 'anthropic': return new AnthropicApiPeer(config);   // Claude Agent SDK
      case 'openai':    return new OpenAiApiPeer(config);       // Codex SDK or direct API
      case 'moonshot':  return new MoonshotApiPeer(config);     // OpenAI-compat API
      // Any other OpenAI-compatible provider:
      default:          return new OpenAiCompatPeer(config);    // generic: openai SDK + baseURL
    }
  }

  // Built-in tool peers (OAuth / CLI subprocess)
  switch (config.provider) {
    case 'anthropic': return new AnthropicApiPeer(config);   // Claude is always API
    case 'openai':    return new CodexToolPeer(config);       // codex exec subprocess
    case 'moonshot':  return new KimiToolPeer(config);        // kimi --print subprocess
    default:
      throw new Error(`No built-in tool adapter for provider "${config.provider}". Register a plugin.`);
  }
}

// Generic OpenAI-compatible peer for any BYOK provider not listed above
// Covers: Groq, Together AI, DeepSeek, Ollama, Azure OpenAI, etc.
class OpenAiCompatPeer implements Peer {
  private client: OpenAI;
  constructor(private config: PeerConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }
  // ... same send() interface as MoonshotApiPeer
}
```

### 12.5 Plugin Manifest

To register a new coding agent as a plugin, create `~/.metaclide/plugins/<plugin-id>/manifest.json`:

```json
{
  "id": "my-agent",
  "displayName": "My Custom Agent",
  "version": "1.0.0",
  "type": "tool",
  "authMethod": "oauth",
  "sessionFile": "~/.my-agent/session.json",
  "contextFile": "AGENTS.md",
  "loginCommand": "my-agent login",
  "execCommand": "my-agent run --headless --json",
  "outputFormat": "ndjson",
  "entrypoint": "./adapter.js"
}
```

The `entrypoint` is a JS file that exports `createPeer(config): Peer` — the same interface as every built-in adapter. MetaCLiDE loads it at runtime. Once registered, the agent appears in `metaclide agents` and can be selected in any session.

---

## 13. Agent Integration — Exact Implementation

This section is the ground truth for how MetaCLiDE drives each agent. All commands, flags, SDKs, and patterns below are verified against official documentation (March 2026).

### 13.1 Claude Code

**Official SDK:** `@anthropic-ai/claude-agent-sdk` (npm) — previously called Claude Code SDK, renamed September 2025.  
**CLI command:** `claude -p` (also called headless mode).  
**Auth:** `ANTHROPIC_API_KEY` env var always. No OAuth for third-party tools.

#### Installation

```bash
npm install @anthropic-ai/claude-agent-sdk
# Claude Code CLI must also be installed on the machine:
npm install -g @anthropic-ai/claude-code
```

#### API-Backed Mode (MVP 1 — BYOK)

```typescript
// src/peers/AnthropicApiPeer.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

export class AnthropicApiPeer implements Peer {
  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const result = query({
      prompt: this.buildPrompt(msg),
      options: {
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'acceptEdits',   // auto-approve file ops
        maxTurns: 30,
        cwd: this.worktreePath,          // peer's isolated worktree
        // Fine-grained bash gating — block deploy/destructive commands
        canUseTool: async (toolName, input) => {
          if (toolName === 'Bash') {
            const cmd = (input as { command: string }).command;
            if (/git push|rm -rf|npm publish|curl.*deploy/.test(cmd))
              return { behavior: 'deny', message: 'Blocked by MetaCLiDE: deploy ops not allowed' };
          }
          return { behavior: 'allow' };
        },
      },
      env: { ANTHROPIC_API_KEY: this.apiKey },
    });

    for await (const message of result) {
      yield this.mapToEvent(message);
      // message.type === 'result' carries: total_cost_usd, session_id, num_turns
    }
  }
}
```

#### Tool-Backed Mode (MVP 3 — CLI subprocess)

```typescript
// src/peers/ClaudeToolPeer.ts
import { execa } from 'execa';
import { createInterface } from 'readline';

export class ClaudeToolPeer implements Peer {
  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const args = [
      '-p', this.buildPrompt(msg),
      '--output-format', 'stream-json',
      '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep',
      '--permission-mode', 'acceptEdits',
      '--max-turns', '30',
    ];
    if (this.sessionId) args.push('--resume', this.sessionId);

    const proc = execa('claude', args, {
      cwd: this.worktreePath,
      env: { ...process.env, ANTHROPIC_API_KEY: this.apiKey },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const rl = createInterface({ input: proc.stdout });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      // event types: 'system' (init), 'assistant', 'result'
      // result carries: { session_id, total_cost_usd, num_turns, result }
      if (event.type === 'system' && event.subtype === 'init') {
        this.sessionId = event.session_id; // persist for multi-turn
      }
      yield this.mapToEvent(event);
    }
    await proc;
  }
}
```

#### Stream-JSON Output Format

```jsonc
// Line 1 — init
{ "type": "system", "subtype": "init", "session_id": "abc-123-..." }

// Mid-stream — assistant thinking/acting
{ "type": "assistant", "message": { "role": "assistant", "content": [...] } }

// Final line
{
  "type": "result",
  "subtype": "success",
  "result": "Implemented product CRUD API...",
  "session_id": "abc-123-...",
  "total_cost_usd": 0.012,
  "num_turns": 8,
  "duration_ms": 34210
}
```

#### Multi-Turn (Contract Review Protocol)

```typescript
// Turn 1: send contract draft for review
const response1 = await execa('claude', [
  '-p', reviewPrompt,
  '--output-format', 'json',
  '--allowedTools', 'Read',
  '--max-turns', '5',
], { cwd: worktreePath, env: { ANTHROPIC_API_KEY: apiKey } });

const { session_id } = JSON.parse(response1.stdout);

// Turn 2: collect structured ACK/REJECT
const response2 = await execa('claude', [
  '-p', 'Reply only with JSON: { "response": "ACK" | "REJECT", "objections": [...] }',
  '--resume', session_id,
  '--output-format', 'json',
], { cwd: worktreePath, env: { ANTHROPIC_API_KEY: apiKey } });
```

#### Context Injection (CLAUDE.md)

Claude Code reads `CLAUDE.md` from the working directory as project memory. MetaCLiDE writes this before every session turn:

```typescript
// Called by WorktreeManager.injectContext() for claude
function buildClaudeMd(peer: string, task: Task, contracts: Contracts): string {
  return `# MetaCLiDE Context\n\n## Your role\n${peer} peer (${task.role})\n\n## Active task\n${task.description}\n\nAcceptance: ${task.acceptance}\n\n## Contracts (READ-ONLY)\nContracts are in .orch/contracts/. Do NOT modify them.\nIf you need a contract change, write a CR to .orch/change-requests/CR-<id>.json\n\n## Status\nWrite your status to .orch/status/claude.json after each significant action.\n`;
}
```

#### Permission Modes

| Mode | Behavior | Use in MetaCLiDE |
|------|----------|-----------------|
| `default` | Prompts on dangerous ops | ❌ Blocks unattended runs |
| `acceptEdits` | Auto-approves file ops, prompts on risky Bash | ✅ Implementation tasks |
| `bypassPermissions` | Auto-approves everything | ⚠️ Only in sandboxed CI |
| `plan` | No execution, planning only | ✅ Review/plan phases |
| `dontAsk` | Denies anything not pre-approved | ❌ Too restrictive |

---

### 13.2 Codex CLI

**Official SDK:** `@openai/codex-sdk` (npm, from `github.com/openai/codex/tree/main/sdk/typescript`).  
**CLI command:** `codex exec` (non-interactive mode).  
**Auth:** `CODEX_API_KEY` env var for API key mode; `~/.codex/auth.json` for OAuth session. `CODEX_API_KEY` only works with `codex exec`, not with the interactive TUI.

#### Installation

```bash
npm install @openai/codex-sdk
# Codex CLI:
npm install -g @openai/codex
# Or on macOS:
brew install codex
```

#### Tool-Backed Mode (OAuth — codex exec)

```typescript
// src/peers/CodexToolPeer.ts
import { execa } from 'execa';
import { createInterface } from 'readline';

export class CodexToolPeer implements Peer {
  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    // Use saved OAuth session from ~/.codex/auth.json (no API key needed)
    // For BYOK: pass CODEX_API_KEY in env instead
    const args = this.threadId
      ? ['exec', 'resume', this.threadId, this.buildPrompt(msg), '--json']
      : ['exec', this.buildPrompt(msg), '--json', '--ephemeral'];

    const proc = execa('codex', args, {
      cwd: this.worktreePath,
      env: {
        ...process.env,
        ...(this.apiKey ? { CODEX_API_KEY: this.apiKey } : {}), // only if BYOK
      },
      stdout: 'pipe',
      stderr: 'pipe',   // Codex streams progress to stderr; MetaCLiDE can log or discard
    });

    const rl = createInterface({ input: proc.stdout });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      // thread.started carries the threadId — save it for resumption
      if (event.type === 'thread.started') this.threadId = event.threadId;
      yield this.mapCodexEvent(event);
    }
    await proc;
  }
}
```

#### API-Backed Mode (BYOK — Codex SDK)

```typescript
// src/peers/OpenAiApiPeer.ts
import { Codex } from '@openai/codex-sdk';

export class OpenAiApiPeer implements Peer {
  private codex = new Codex({ apiKey: this.apiKey, cwd: this.worktreePath });
  private thread = this.codex.startThread();

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const result = await this.thread.run(this.buildPrompt(msg));
    yield { type: 'text', data: result };
    // Call thread.run() again on the same thread for multi-turn (contract review)
  }

  async resumeThread(threadId: string): Promise<void> {
    this.thread = this.codex.resumeThread(threadId);
  }
}
```

#### JSONL Event Stream Format

```jsonc
{ "type": "thread.started",   "threadId": "t_abc123" }
{ "type": "turn.started",     "turnId": "turn_1" }
{ "type": "item.started",     "item": { "id": "i1", "type": "agent_message" } }
{ "type": "item.updated",     "item": { "id": "i1", "type": "agent_message", "text": "Reading contracts..." } }
{ "type": "item.completed",   "item": { "id": "i2", "type": "command", "command": "cat .orch/contracts/api.openapi.yaml" } }
{ "type": "item.completed",   "item": { "id": "i3", "type": "file_change", "path": "src/api/products.ts", "operation": "create" } }
{ "type": "turn.completed",   "usage": { "input_tokens": 24763, "output_tokens": 1892 } }
```

Item types to handle: `agent_message`, `reasoning`, `command`, `file_change`, `mcp_tool_call`, `web_search`, `plan_update`.

#### Session Resumption

```bash
# Phase 1 — review
codex exec "Review .orch/contracts/ and reply with ACK or REJECT JSON"
# → saves session; thread ID emitted in thread.started event

# Phase 2 — implementation (after contract locked)
codex exec resume <THREAD_ID> "Contracts are now locked. Proceed with implementation."
# OR resume the most recent session:
codex exec resume --last "Contracts locked. Proceed."
```

#### Approval Policy

```bash
# Never pause for approval during unattended MetaCLiDE runs
codex exec --approval-policy never "Implement task-001"

# Or set in ~/.codex/config.toml per profile:
# [profiles.metaclide]
# approval_policy = "never"
# sandbox_mode = "workspace-write"
```

Available sandbox modes: `read-only` (default), `workspace-write`, `danger-full-access`.  
Use `workspace-write` for implementation tasks. Never use `danger-full-access` outside a sandboxed container.

#### Context Injection (AGENTS.md)

Codex reads `AGENTS.md` from the repo root. MetaCLiDE writes this to the peer's worktree before each session:

```typescript
function buildAgentsMd(peer: string, task: Task): string {
  return `# MetaCLiDE Context\n\n## Role\n${peer} peer\n\n## Active task\n${task.description}\n\nAcceptance: ${task.acceptance}\n\n## Rules\n- .orch/contracts/* is READ-ONLY\n- Write status to .orch/status/${peer}.json\n- File CRs to .orch/change-requests/ if contracts are insufficient\n`;
}
```

---

### 13.3 Kimi Code

**Official SDK:** `@moonshot-ai/kimi-agent-sdk` (npm, `github.com/MoonshotAI/kimi-agent-sdk`). Also available in Python and Go.  
**CLI command:** `kimi --print -y -p "<prompt>"` (non-interactive flag).  
**Auth:** `MOONSHOT_API_KEY` static key from `platform.moonshot.ai`. OAuth available (browser-based) but issues short-lived JWTs — use static key for MetaCLiDE.  
**Direct API:** OpenAI-compatible endpoint at `https://api.moonshot.cn/v1` — no CLI required.

#### Installation

```bash
# CLI (Python-based):
pip install kimi-cli
# OR:
uv tool install kimi-cli

# Node SDK:
npm install @moonshot-ai/kimi-agent-sdk
```

#### API-Backed Mode (BYOK — Direct OpenAI-compatible API, MVP 1)

This is the cleanest path for MVP 1/2 — no CLI installation required.

```typescript
// src/peers/MoonshotApiPeer.ts
import OpenAI from 'openai'; // standard openai npm package

export class MoonshotApiPeer implements Peer {
  private client = new OpenAI({
    apiKey: this.apiKey,
    baseURL: 'https://api.moonshot.cn/v1',
  });

  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const stream = this.client.chat.completions.stream({
      model: 'kimi-k2-thinking-turbo',  // or 'kimi-k2', 'kimi-coding-k2.5'
      messages: this.buildMessages(msg),
      max_tokens: 16000,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      if (text) yield { type: 'text', data: text };
    }

    const finalMessage = await stream.finalMessage();
    // finalMessage.usage = { prompt_tokens, completion_tokens, total_tokens }
  }

  private buildMessages(msg: PeerMessage): OpenAI.ChatCompletionMessageParam[] {
    return [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user',   content: msg.content },
    ];
  }
}
```

#### Tool-Backed Mode (OAuth/CLI — Kimi Agent SDK, MVP 3)

```typescript
// src/peers/KimiToolPeer.ts
// Uses the official Kimi Agent SDK which wraps the kimi CLI process
// communicating via JSON-RPC 2.0 over stdin/stdout
import { KimiSession } from '@moonshot-ai/kimi-agent-sdk';

export class KimiToolPeer implements Peer {
  async *send(msg: PeerMessage): AsyncIterable<PeerEvent> {
    const session = new KimiSession({
      apiKey: this.apiKey,               // undefined if using OAuth session
      model: 'kimi-k2-thinking-turbo',
      cwd: this.worktreePath,
    });

    const turn = await session.prompt(msg.content);

    for await (const step of turn.steps) {
      for await (const m of step.messages) {
        if (m.type === 'text') yield { type: 'text', data: m.value };
        if (m.type === 'approvalRequest') {
          // Auto-approve safe ops, block deploy commands
          const safe = /^(ls|cat|grep|npm (install|test|build))/.test(m.action);
          m.respond(safe ? 'approve' : 'deny');
        }
      }
    }

    await session.close();
  }
}
```

#### CLI Subprocess Fallback

```typescript
// src/peers/KimiToolPeer.ts — subprocess fallback
import { execa } from 'execa';

async function *spawnKimiPrint(prompt: string, worktreePath: string, apiKey?: string) {
  const proc = execa('kimi', ['--print', '-y', '-p', prompt], {
    cwd: worktreePath,
    env: {
      ...process.env,
      ...(apiKey ? { MOONSHOT_API_KEY: apiKey } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const rl = createInterface({ input: proc.stdout });
  for await (const line of rl) yield { type: 'text', data: line };
  await proc;
}
```

#### Available Models

| Model | Best For | Context |
|-------|----------|---------|
| `kimi-k2` | General coding tasks | 256K |
| `kimi-k2-thinking-turbo` | Complex planning, architecture review | 256K |
| `kimi-coding-k2.5` | Specialized code generation | 256K |

**Pricing:** $0.60/M input tokens, $2.50/M output tokens (10× cheaper than Claude Sonnet).

#### Context Injection (AGENTS.md)

Same as Codex — Kimi reads `AGENTS.md`. Use the same `buildAgentsMd()` helper as Codex.

---

### 13.4 Prompt Engineering for All Peers

Every message MetaCLiDE sends to a peer is structured to minimize token waste and maximize structured output. Use this template as the base:

```typescript
// src/peers/buildPrompt.ts
export function buildPrompt(
  peer: string,
  phase: Phase,
  msg: PeerMessage,
  contractHash: string
): string {
  const header = `
[METACLIDE ORCHESTRATOR — ${phase.toUpperCase()} PHASE]
Contract version: ${contractHash}
Your branch: agent/${peer}
Worktree: .orch/worktrees/${peer}/
`.trim();

  const instructions = {
    review:     'Review the contracts in .orch/contracts/. Reply ONLY with JSON: { "response": "ACK" | "REJECT", "objections": string[] }',
    implement:  'Implement the task below in your worktree. Write status to .orch/status/' + peer + '.json when done.',
    fix:        'Fix the failing gate below. Do not change .orch/contracts/*.',
    discuss:    'Respond with your analysis. Be concise.',
  }[msg.type];

  return `${header}\n\n${instructions}\n\n---\n\n${msg.content}`;
}
```

---

## 14. Key Data Schemas

### 14.1 plan.json

```json
{
  "version": 1,
  "project": "ecommerce-app",
  "stack": ["nextjs", "express", "prisma", "postgres", "tailwind"],
  "tasks": [
    {
      "id": "task-001",
      "title": "Implement product CRUD API",
      "owner": "codex",
      "status": "in-progress",
      "phase": "implement",
      "dependencies": [],
      "acceptance": "All /api/products endpoints match api.openapi.yaml"
    },
    {
      "id": "task-002",
      "title": "Build product listing page",
      "owner": "claude",
      "status": "pending",
      "phase": "implement",
      "dependencies": ["task-001"],
      "acceptance": "Page /products renders data from GET /api/products"
    }
  ]
}
```

### 14.2 pages.routes.json

```json
{
  "routes": [
    {
      "path": "/products",
      "component": "ProductListPage",
      "endpoints": ["GET /api/products"],
      "auth": false
    },
    {
      "path": "/admin/users",
      "component": "AdminUsersPage",
      "endpoints": ["GET /api/admin/users"],
      "auth": true,
      "roles": ["admin"]
    }
  ]
}
```

### 14.3 Discussion Thread (T-001.md)

```markdown
# Thread T-001: User Listing Strategy

## codex (conductor) — 2026-03-02 14:01
Proposing two separate endpoints: /api/users for public user list,
/api/admin/users for admin panel with role info. Frontend routes:
/users (public), /admin/users (admin-only, auth-gated).

## claude — 2026-03-02 14:02
ACK. Suggest adding pagination params to both endpoints (page, limit).

## kimi — 2026-03-02 14:02
ACK. Will implement auth middleware for /admin/* routes.

## codex (conductor) — 2026-03-02 14:03
Accepted. Adding pagination to api.openapi.yaml. Locking contract v1.
```

---

## 15. End-to-End Execution Flow

When a user types: "I need a full-stack ecommerce app with Next.js, Express, Prisma, Postgres"

1. **Select peers** — User picks which connected agents to use. E.g. 2 peers: Codex (Conductor, OAuth) + Claude (BYOK). Or 3. Or more. MetaCLiDE loads `peers.json` and instantiates one adapter per selected peer.
2. **Brief** — MetaCLiDE writes requirements to `.orch/brief.md`.
3. **Discuss** — All selected peers receive the brief and hold a structured discussion (mediated by MetaCLiDE through the shared thread log). They agree on roles and a rough task split.
4. **Plan** — Conductor drafts architecture, contracts (OpenAPI, page routes, shared types, entity schemas, DB schema) from the discussion outcome. Sets `VERSION = 1`.
5. **Review** — All other peers receive the draft. Each responds ACK or REJECT with objections. Conductor revises until consensus. Discussion logged in `.orch/threads/`.
6. **Lock** — Conductor writes `LOCK.contracts`, tags `contract-v1` in git. All peers write ACK (version + hash) to their status files.
7. **Assign** — Tasks in `plan.json` are assigned to peers based on discussion. Each peer gets a worktree (`agent/<peer-id>` branch).
8. **Implement** — Each agent works in its own git worktree in parallel. If a gap is found, a CR is filed, all peers pause, Conductor resolves atomically.
9. **Integrate** — Conductor merges all peer branches into `integration`. Verification gates + mismatch detectors run.
10. **Fix Loop** — Gate/mismatch failures become Fix Tasks. Responsible peer fixes, re-merge, re-verify. Bounded by 5 iterations or budget cap.
11. **Deliver** — User gets: runnable code, `.orch/integration-report.md`, how-to-run instructions.

---

## 16. MVP Roadmap

### MVP 0: Foundation (Week 1–2)

- oclif project scaffold with interactive chat session.
- `.orch/` directory structure + Zod schemas for all state files including `peers.json`.
- `WorktreeManager` using `simple-git` — creates one worktree per entry in `peers.json`.
- Contract lock mechanism (`LOCK.contracts` + VERSION + hash).
- Verification gates runner (execa: lint, typecheck, test, build).
- Fix-loop mechanism (gate failure → Fix Task → retry, bounded at 5).
- `keytar` integration: store/retrieve credentials from OS keychain keyed by `metaclide/<agent-id>`.
- Session detection utility for known CLI agents.

### MVP 1: 2-Peer BYOK Collaboration (Week 3–4)

- `AnthropicApiPeer` — `@anthropic-ai/claude-agent-sdk`, key from keychain.
- `MoonshotApiPeer` — `openai` SDK at `api.moonshot.cn/v1`, key from keychain.
- `OpenAiCompatPeer` — generic OpenAI-compatible adapter (any `baseURL`).
- `metaclide agents add` — interactive wizard to configure any 2+ agents.
- Discussion phase: structured multi-turn conversation between selected peers before planning.
- Contract-first protocol: discuss → plan → review (ACK/REJECT JSON) → lock → implement → integrate.
- End-to-end test: 2-peer session, one prompt → working full-stack app.

### MVP 2: Ink TUI + Session Persistence (Week 5–7)

- React + Ink v5 terminal UI replacing readline REPL.
- Component hierarchy: `<App>` → `<Header>`, `<ChatHistory>`, `<InputField>`, `<StatusBar>`.
- Streaming conductor responses with markdown rendering.
- Arrow-key conductor selection (Claude / Codex / Kimi with mode indicator).
- Masked API key input via Ink text input component.
- Tool use display with spinners and status transitions.
- Slash command handling (`/run`, `/status`, `/logs`, `/connect`, `/sessions`, `/new`, `/compact`, `/help`, `/exit`).
- JSONL session persistence in `~/.metaclide/sessions/<workspace>/<uuid>/`.
- Session resume: `--continue`, `--session <id>`, `/sessions` picker.

### MVP 3: Native OAuth Flows (Week 8–9)

- `src/lib/auth/oauth.ts` — shared OAuth primitives (PKCE, device code, token refresh).
- Codex OAuth: PKCE browser flow (local server on :1455) + device code fallback.
  - Token exchange for `sk-...` API key from `id_token`.
  - Token storage at `~/.codex/auth.json`.
  - Auto-refresh when `last_refresh` > 8 days.
- Kimi OAuth: Device code flow (RFC 8628).
  - `X-Msh-*` platform headers on all requests.
  - Token storage at `~/.kimi/credentials/kimi-code.json`.
  - Background refresh every 60s, trigger when <5 min to expiry.
- OAuth integrated into conductor selection (detected sessions shown with green indicator).
- Token refresh manager running in background during active sessions.

### MVP 4: N-Peer + Mismatch Detection (Week 10–12)

- Verified N-peer sessions (3+ peers with mixed OAuth + BYOK).
- Mismatch detectors (API, schema, route, DB).
- Auto-generated CRs from mismatch detectors.
- Consensus pause on CR filing (works for any N peers).
- Session crash recovery (resume from last known state).

### MVP 5: Plugin Registry + Polish (Week 13+)

- Plugin manifest format and loader (`~/.metaclide/plugins/<id>/manifest.json`).
- `metaclide agents add --plugin <path>` to register custom CLI agents.
- PR/patch export (GitHub, GitLab).
- Cross-platform packaging (Windows + macOS binaries).
- Agent capability profiles — user annotates which peer is best at frontend/backend/testing.

---

## 17. Known Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Provider blocks third-party OAuth usage | Tool-backed peers break | BYOK as always-available fallback |
| PTY parsing is brittle across tool versions | Incorrect state reads | Don't use PTY for headless modes — all three CLIs have proper stdout output modes |
| Agents produce conflicting code despite contract | Integration failures | Mismatch detectors catch it; auto-generated CRs; fix loop resolves |
| Budget exceeded mid-task | Incomplete output | Checkpoint state; resume command; clear budget warnings |
| Single peer deadlocks contract review | Infinite review loop | Conductor timeout: decide after N seconds if peer doesn't respond |
| Contract too rigid for complex projects | Excessive CRs, slow iteration | Interface ownership lets specialists propose targeted changes |
| Kimi JWT rotation (OAuth mode) | 401 errors mid-session | Use static `MOONSHOT_API_KEY` from platform.moonshot.ai instead of OAuth JWTs |
| Codex API key scope | CODEX_API_KEY not working | `CODEX_API_KEY` only works in `codex exec`, not TUI — this is correct usage |
| New coding-agent tools emerge | Need new adapters | Plugin/adapter architecture; common Peer interface makes additions easy |

---

## 18. Invariants

1. Contracts are the truth: `.orch/contracts/*` is the canonical specification.
2. Only the Conductor edits contracts.
3. Every peer in `peers.json` must ACK contract version + hash before coding begins.
4. Contract changes only via Change Requests.
5. Consensus pause: **all** active peers halt when a CR is filed — regardless of peer count.
6. Each peer works in its own isolated git worktree; one worktree per entry in `peers.json`.
7. Integration gates + mismatch detectors decide "done."
8. Mismatches auto-generate CRs; Conductor resolves once; peers conform.
9. Fix loop is bounded: max 5 iterations or budget cap.
10. No bilateral negotiation: peers never directly negotiate with each other. Everything goes through the Conductor or the contract.
11. Peer count is runtime configuration — core orchestration logic never hardcodes 2, 3, or any fixed number of peers.
12. Any new agent reachable via OpenAI-compatible API or a CLI subprocess can be added as a peer without changing core orchestration code.

---

## Appendix A: npm Packages

```bash
# Core
npm install @oclif/core execa simple-git keytar zod yaml

# Provider SDKs
npm install @anthropic-ai/sdk               # Claude Messages API (conductor chat + peer adapter)
npm install @anthropic-ai/claude-code        # Claude Code SDK query() (peer adapter)
npm install openai                           # Codex/Kimi BYOK + any OpenAI-compat provider

# Terminal UI (React + Ink)
npm install ink ink-text-input ink-spinner ink-select-input react
npm install cli-markdown                     # Markdown-to-ANSI rendering

# Interactive prompts (used in oclif commands outside TUI)
npm install @inquirer/prompts

# CLI tools (only needed if using tool/subprocess mode for that agent)
npm install -g @anthropic-ai/claude-code     # Claude Code CLI
npm install -g @openai/codex                 # Codex CLI
pip install kimi-cli                         # Kimi Code CLI
```

## Appendix B: Environment Variables Reference

| Variable | Used By | Required | Notes |
|----------|---------|----------|-------|
| `ANTHROPIC_API_KEY` | Claude Code CLI + Agent SDK | Always for Claude | API key from console.anthropic.com |
| `CODEX_API_KEY` | Codex CLI (`codex exec` only) | BYOK only | API key from platform.openai.com |
| `OPENAI_API_KEY` | OpenAI SDK (Codex BYOK) | BYOK fallback | Standard OpenAI key |
| `MOONSHOT_API_KEY` | Moonshot API + Kimi Agent SDK | BYOK only | Key from platform.moonshot.ai |
| `CLAUDE_CODE_USE_BEDROCK` | Claude Agent SDK | Optional | Set to `1` for AWS Bedrock routing |
| `CLAUDE_CODE_USE_VERTEX` | Claude Agent SDK | Optional | Set to `1` for GCP Vertex AI routing |

Plugin agents declare their own required env vars in `manifest.json` under `"envVars": [...]`. MetaCLiDE reads these at `metaclide agents add` time and prompts the user to supply them, storing values in the OS keychain under `metaclide/<agent-id>-<var-name>`.

## Appendix C: CLI Reference for Agent Non-Interactive Modes

```bash
# ── Claude Code ─────────────────────────────────────────────────────────────
claude -p "<prompt>" --output-format stream-json \
  --allowedTools "Read,Edit,Write,Bash" \
  --permission-mode acceptEdits \
  --max-turns 30

# Resume a session
claude -p "<prompt>" --resume <session_id>

# One-shot JSON response (for ACK/REJECT protocol)
claude -p "<prompt>" --output-format json

# ── Codex CLI ────────────────────────────────────────────────────────────────
codex exec "<prompt>" --json --approval-policy never

# Resume previous session
codex exec resume <thread_id> "<prompt>"
codex exec resume --last "<prompt>"

# Structured output (for ACK/REJECT protocol)
codex exec "<prompt>" --output-schema ./ack-schema.json

# Skip git repo check (if running outside git root)
codex exec --skip-git-repo-check "<prompt>"

# ── Kimi Code CLI ────────────────────────────────────────────────────────────
kimi --print -y -p "<prompt>"

# ACP server mode (not used by MetaCLiDE — IDE integration only)
kimi acp
```

---

## 19. Implementation Audit (March 2026)

*Full line-by-line audit of every source file against the spec. Each component is rated: ✅ solid / ⚠️ incomplete / ❌ broken.*

### 19.1 Core Infrastructure

| File | Status | Notes |
|------|--------|-------|
| `src/types.ts` | ✅ | All types correct. `PeerEvent.type` uses `tool_use/result` instead of spec's `file_write/command/done` — acceptable divergence. |
| `src/lib/orch/schema.ts` | ✅ | Zod schemas match types exactly. |
| `src/lib/orch/paths.ts` | ✅ | All paths correct per §5 layout. |
| `src/lib/orch/index.ts` | ✅ | Full CRUD for all state files. `findRepoRoot`, `requireOrch`, `bumpContractVersion`, `allPeerStatuses` all present. |
| `src/lib/contracts/lock.ts` | ✅ | `lock()`, `unlock()`, `hashContracts()` (SHA-256, 8-char prefix), `validatePeerAck()` — all correct. |
| `src/lib/contracts/validation.ts` | ⚠️ | `detectMismatches()` only checks file existence. The 4 mismatch detectors from §9.2 (API, schema, route, DB) are stubs with `// TODO` comment. |
| `src/lib/gates/index.ts` | ✅ | `runAll()`, `runAllParallel()`, `passed()` — correct. Minor: `cmd.split(' ')` won't handle quoted args (edge case). |
| `src/lib/router/index.ts` | ⚠️ | Budget tracking correct. `selectPeer()` is naive (picks first implementer). No capability-based routing, no phase-based routing (§10.2), no fallback on provider error. |
| `src/lib/git/worktree.ts` | ✅ | `create()`, `remove()`, `list()`, `mergePeerBranch()`, `tagContract()`, `commit()` all correct. Missing: symlink `.orch` into each worktree (spec §8.2 requires this so agents can read contracts). |
| `src/lib/logger/index.ts` | ✅ | JSONL append/read/tail/stream, `SessionLogger` multi-peer wrapper — correct. |

### 19.2 Auth

| File | Status | Notes |
|------|--------|-------|
| `src/lib/auth/session.ts` | ✅ | `SESSION_FILES`, `detectInstalledCLIs()`, `BUILT_IN_AGENTS`, `getAgentsWithStatus()` — all correct. |
| `src/lib/auth/keychain.ts` | ✅ | keytar with base64 file fallback at `~/.metaclide/credentials.json`. Correct. |
| `src/lib/auth/oauth-codex.ts` | ✅ with bug | PKCE browser flow (port 1455), device code fallback, token exchange, refresh logic all correct per spec §4.1.1. **Bug on line 334**: `refreshCodexTokens()` sends `JSON.stringify()` body to a form-urlencoded endpoint — must be `body.toString()` with `Content-Type: application/x-www-form-urlencoded`. |
| `src/lib/auth/oauth-kimi.ts` | ✅ | RFC 8628 device code, `X-Msh-*` headers, `getOrCreateDeviceId()`, token refresh at <5min threshold, revocation detection (401/403 → delete tokens) — all correct per spec §4.1.2. |

### 19.3 Peer Adapters — Critical Bugs

#### ClaudePeer (`src/lib/peers/claude.ts`) — ❌ Broken

**Bug 1: Wrong package name** (line 50)
```typescript
// Current — BROKEN (deprecated package, missing entry points):
const {query} = await import('@anthropic-ai/claude-code')

// Fix:
const {query} = await import('@anthropic-ai/claude-agent-sdk')
```

**Bug 2: No session persistence** — `session_id` from `system/init` event is never captured. Without it, multi-turn contract review (§7.3) and session resumption (§11.3) cannot work.
```typescript
// Must capture from stream:
if (e.type === 'system' && e.subtype === 'init') {
  this.sessionId = (e as any).session_id
}
// Then pass on subsequent calls:
options: { ..., resume: this.sessionId }
```

**Bug 3: No bash gating** — spec §13.1 requires blocking `git push|rm -rf|npm publish|curl.*deploy` via `canUseTool`. Not implemented.

**Bug 4: `.orch` not symlinked in worktree** — agents read contracts via `.orch/contracts/`. Without the symlink, Claude can't read the contracts it's supposed to implement against.

#### CodexPeer (`src/lib/peers/codex.ts`) — ❌ Broken

**Bug 1: Completely wrong NDJSON event format** — current parsing looks for `event.type === 'message'`, `'tool_call'`, `'session'`, `'done'`. None of these exist. Real `codex exec --json` events:
```json
{"type": "thread.started", "thread_id": "t_abc123"}
{"type": "turn.started", "turn_id": "turn_1"}
{"type": "item.started", "item_id": "i1", "item_type": "agent_message"}
{"type": "item.updated", "item_id": "i1", "content": "Reading contracts..."}
{"type": "item.completed", "item_id": "i2", "item_type": "file_change", "path": "src/api.ts", "operation": "create"}
{"type": "item.completed", "item_id": "i3", "item_type": "command_execution", "command": "npm test"}
{"type": "turn.completed", "usage": {"input_tokens": 24763, "output_tokens": 1892}}
```
All `processCodexEvent()` logic must be rewritten.

**Bug 2: Thread resumption never used** — `lastThreadId` is declared (line 13) but never passed to `codex exec`. Must add `codex exec resume <threadId>` when `lastThreadId` is set.

**Bug 3: No `--sandbox workspace-write`** — Codex default sandbox is `read-only`. Agents cannot write files. Must add `--sandbox workspace-write` to `codex exec` args.

**Bug 4: Wrong env var name** — Sets `OPENAI_API_KEY` but codex exec requires `CODEX_API_KEY` (line 48). Both should be set as fallback chain.

**Correct args for CodexPeer:**
```typescript
const args = this.lastThreadId
  ? ['exec', 'resume', this.lastThreadId, prompt, '--json', '--approval-policy', 'never']
  : ['exec', prompt, '--json', '--approval-policy', 'never', '--sandbox', 'workspace-write']

env: {
  ...process.env,
  ...(this.config.apiKey ? {CODEX_API_KEY: this.config.apiKey, OPENAI_API_KEY: this.config.apiKey} : {}),
}
```

#### KimiPeer (`src/lib/peers/kimi.ts`) — ❌ Broken

**Bug 1: Wrong CLI flags** (line 116)
```typescript
// Current — BROKEN:
execa('kimi', ['--print', prompt, '--json'], ...)

// Fix:
execa('kimi', ['--print', '-y', '-p', prompt, '--work-dir', this.worktreePath, '--output-format', 'stream-json'], ...)
```

**Bug 2: Wrong API endpoint** — Using `https://api.moonshot.cn/v1` (China-only). Use `https://api.moonshot.ai/v1` (international) as primary.

**Bug 3: Wrong pricing** (line 93-94) — Uses `0.000012` per token for both input/output.
```typescript
// Correct per spec §13.3 ($0.60/M input, $2.50/M output):
const costUsd = usage
  ? (usage.prompt_tokens * 0.0000006 + usage.completion_tokens * 0.0000025)
  : 0
```

**Bug 4: Wrong NDJSON parsing** — `event.type === 'content'` doesn't exist. Kimi CLI with `--output-format stream-json` outputs wire protocol events via JSON-RPC 2.0. For API mode, the current streaming approach is correct.

### 19.4 TUI

| File | Status | Notes |
|------|--------|-------|
| `src/tui/App.tsx` | ⚠️ | Single-conductor chat works. OAuth flows work. Slash commands `/help`, `/exit`, `/conductor` work. `/run`, `/status`, `/logs` redirect to CLI (stubs). No multi-agent dashboard. No in-TUI orchestration. |
| `src/tui/Header.tsx` | ⚠️ | Shows conductor, project, model, phase. Needs peer status row expansion for multi-agent view. |
| `src/tui/ChatHistory.tsx` | ⚠️ | Works. Needs agent label on messages when multiplexing N-peer output. |
| `src/tui/Message.tsx` | ⚠️ | Works. Needs `peer` field on `MessageData` for colored agent labels. |
| `src/tui/StatusBar.tsx` | ⚠️ | Minimal loading indicator. Needs peer activity rows. |
| `src/tui/ConductorSelect.tsx` | ✅ | Session detection (green dot for active sessions) works correctly. |
| `src/tui/ApiKeyInput.tsx` | ✅ | Masked input, correct. |
| `src/tui/conductor.ts` | ⚠️ | `ConductorChat` works for single-conductor phase. Anthropic path streams correctly. OpenAI path does not stream (uses `.create()` not `.stream()`). This is the chat-before-run experience. |

### 19.5 Commands

| File | Status | Notes |
|------|--------|-------|
| `src/commands/init.ts` | ✅ | Clean. |
| `src/commands/connect.ts` | ✅ | Interactive + flag-based agent connection. |
| `src/commands/agents/index.ts` | ✅ | Lists all agents with connection/session status. |
| `src/commands/agents/add.ts` | ✅ | Adds peer with role, stores key. |
| `src/commands/agents/remove.ts` | ✅ | Removes peer, optional key deletion. |
| `src/commands/status.ts` | ✅ | Shows full session state. `--json` flag. |
| `src/commands/logs.ts` | ✅ | JSONL tail/follow with `--agent`, `--type` filters. |
| `src/commands/resume.ts` | ⚠️ | Detects state (pending CRs, gate failures, phase) but doesn't actually resume — tells user to re-run `metaclide run --skip-planning`. Should trigger the orchestration loop directly. |
| `src/commands/export.ts` | ✅ | zip, patch, PR via `gh`. |
| `src/commands/doctor.ts` | ✅ | Checks Node.js, git, .orch, keytar, CLIs, env vars, gh. |
| `src/commands/run.ts` | ⚠️ | All 6 phases implemented. Issues: (a) no discussion phase before planning, (b) no CR detection during implementation (consensus pause §7.5 missing), (c) fix loop doesn't assign fix tasks to peers — just re-runs gates in a loop without fixing code. |
| `src/commands/interactive.ts` | ✅ | Renders Ink TUI correctly. |

### 19.6 package.json

**Bug**: Lists `"@anthropic-ai/claude-code": "^1.0.0"` — this is the deprecated package. Must be replaced:
```json
// Remove:
"@anthropic-ai/claude-code": "^1.0.0"

// Add:
"@anthropic-ai/claude-agent-sdk": "^1.0.0"
```

Also missing: `cli-markdown` for markdown-to-ANSI rendering in TUI (spec §11.1).

---

## 20. What Needs to Happen (Prioritized)

### P0 — Fix Before Anything Works

1. **`package.json`**: Replace `@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk`
2. **`claude.ts`**: Fix import, add session_id capture + `options.resume`, add `canUseTool` bash gate
3. **`codex.ts`**: Rewrite `processCodexEvent()` for real event format, add `--sandbox workspace-write`, fix thread resumption, fix env vars
4. **`kimi.ts`**: Fix CLI flags (`-y -p <prompt> --work-dir <path> --output-format stream-json`), fix API endpoint to `.ai`, fix pricing
5. **`oauth-codex.ts` line 334**: Fix refresh body encoding (JSON → form-urlencoded)
6. **`worktree.ts`**: Add `.orch` symlink on worktree creation so agents can read contracts

### P1 — Complete the Protocol

7. **`run.ts`**: Add discussion phase before planning — send brief to all peers, collect discussion, feed into conductor's planning prompt
8. **`run.ts`**: Add CR detection during implementation — poll `.orch/change-requests/` while `Promise.all` runs; on new CR, cancel running peers, trigger consensus pause, resolve, resume
9. **`run.ts`**: Fix the fix loop — gate failure should create Fix Task and send it to the responsible peer, not just re-run gates blindly
10. **`resume.ts`**: Actually re-enter the `run.ts` orchestration loop from the correct phase instead of just printing instructions
11. **`validation.ts`**: Implement real mismatch detectors — parse OpenAPI vs grep for `fetch()` calls, JSON Schema vs TypeScript types, routes JSON vs component files

### P2 — TUI Becomes the Orchestration View

12. **`App.tsx`**: After the single-conductor brief phase, add `/run` that launches the full orchestration pipeline inline (not via CLI subprocess)
13. **`App.tsx`**: Multi-agent activity view — when run is active, show each peer's current status (phase, last tool call, cost) updating live
14. **`Header.tsx`**: Add peer status row: one line per active peer with colored indicator (planning/implementing/blocked/done)
15. **`Message.tsx` + `ChatHistory.tsx`**: Add `peerId` field to `MessageData`, render colored peer labels `[claude]`, `[codex]`, `[kimi]` on multiplexed output
16. **`conductor.ts`**: Add streaming for OpenAI path (use `.stream()` not `.create()`)

### P3 — Session Persistence (MVP 2)

17. Persist Claude `session_id` + Codex `thread_id` to `.orch/sessions/<peer>.json` so `metaclide resume` can actually re-enter agent sessions
18. TUI session persistence: `~/.metaclide/sessions/<workspace-hash>/<uuid>/` with context.jsonl, wire.jsonl, state.json
19. `--continue` and `--session <id>` flags on `metaclide` entrypoint

### P4 — Full Mismatch Detection + OAuth (MVP 3/4)

20. Kimi OAuth mode: integrate `@moonshot-ai/kimi-agent-sdk` `KimiSession` for tool-backed subprocess mode with approval handling
21. Real mismatch detectors using AST/parser-based analysis
22. Auto-generated CRs from mismatch detector output
23. Token refresh manager background loop for Kimi (refresh every 60s when session active)

---

## 21. Architecture Decision: Single Terminal, Multiple Agents

The core UX goal of MetaCLiDE is this: instead of opening 3 terminals (Claude Code, Codex, Kimi) each with separate context and no awareness of each other, the user gets **one terminal** where:

- All 3 run as background subprocess/SDK sessions, each in an isolated git worktree
- Their stdout/events are multiplexed into one display stream, labeled by agent
- One is designated Conductor (routes messages, owns contracts)
- All share `.orch/contracts/` as a read-only source of truth via symlink
- The user talks to the Conductor; the Conductor routes tasks to peers
- The TUI shows real-time parallel progress across all agents

**This does NOT require forking Claude Code.** Claude Code is a single-threaded single-agent loop. MetaCLiDE uses the `@anthropic-ai/claude-agent-sdk`'s `query()` function (or `claude -p` subprocess) to drive Claude as one peer among several. Same for Codex (`codex exec --json`) and Kimi (`kimi --print -y -p`). MetaCLiDE is the orchestrator above them — not a modification of any of them.

The current `oclif + Ink + peer adapters` stack is the correct architecture. Fix the 6 P0 bugs, then build the TUI orchestration view on top of what's already here.
