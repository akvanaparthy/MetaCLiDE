# MetaCLiDE — Project Overview

*A terminal-first orchestrator that makes multiple AI coding agents collaborate as a peer team, routing each task to the cheapest capable model so users stop burning subscription quotas on the wrong tool for the job.*

---

## 1. The Problem We're Solving

Modern developers pay for **multiple AI coding subscriptions** — Claude Pro/Max, ChatGPT Plus (Codex), Kimi, sometimes Gemini — but in practice can only use **one at a time**, switching tabs and re-explaining context to each one. The result is three layered inefficiencies:

1. **Wrong-tool-for-the-job.** People use whichever agent they happen to have open, even when a different model would be cheaper, faster, or better at that specific task.
2. **Token waste through redundant context.** Every switch re-loads files, re-explains constraints, and re-issues system prompts. The same project is paid for again and again.
3. **No collaboration between agents.** Two strong agents can't split work; they can't review each other; one of them sits idle while the other thrashes.

Underneath those is a deeper structural issue: **a single agent doing a full-stack project burns its strongest model on tasks that a weaker, cheaper model would handle just as well.** Opus-grade reasoning shouldn't be wiring up a CRUD endpoint. Sonnet shouldn't be the one running a pure boilerplate scaffold. Haiku is enough for an API integration. Kimi (at ~10× cheaper than Sonnet) is enough for routine backend logic with its 256K context. Gemini is great at UI work. Spending Opus tokens on any of those is lighting money on fire.

**MetaCLiDE's thesis:** if we let multiple coding agents work on the same codebase as a *team* — each handling the kind of task they're best at, each with strict budget caps — we extract dramatically more value per dollar of subscription/API spend, **without** asking the user to manually decide who does what.

---

## 2. The Core Idea in One Paragraph

MetaCLiDE is a TypeScript CLI that the user runs from any project directory. The user picks 2 or more AI coding agents (Claude Code, Codex CLI, Kimi Code, or any plugin agent), connects them with whatever auth mode each one supports (OAuth subscription, BYOK API key, OpenRouter, or even a localhost endpoint like Ollama / LM Studio), and gives the system a project brief. From there, MetaCLiDE assigns one agent as **Conductor**, has all the agents **discuss** the brief, has the Conductor **draft contracts** (OpenAPI, route map, schemas, types), gets every peer to **ACK or REJECT** those contracts, **locks them**, and then **runs the implementers in parallel** — each in its own git worktree on its own branch — before merging the result, running verification gates, and delivering a working project. Tasks are routed to the capable-but-cheapest model for the job, budgets are enforced per-provider/per-phase/per-session, and a contract-first protocol prevents agents from oscillating into infinite loops of mutual edits.

---

## 3. The Routing Vision: Right Model for the Right Task

The whole point of running multiple agents is that **not every task deserves the same model class**. MetaCLiDE's routing heuristic (partially implemented today, formalized in roadmap) is roughly:

| Task type                              | Preferred model class                          | Why                                                                 |
|----------------------------------------|------------------------------------------------|---------------------------------------------------------------------|
| Architecture, contract drafting        | Strongest reasoning model (Opus, Sonnet)       | Mistakes here propagate through the whole project                   |
| Backend business logic / standard CRUD | Mid-tier (Sonnet, Kimi K2 Coding, Codex)       | Routine but needs correctness; Kimi is ~10× cheaper than Sonnet     |
| API integration / glue code            | Cheap, fast (Haiku, Sonnet, Kimi)              | Pattern-following work; smaller models do this fine                 |
| Frontend / UI                          | Strong-at-UI (Gemini, Sonnet, Codex)           | Visual + design context matters; some models are notably better here |
| Testing, fix-loop, lint cleanup        | Cheap (Haiku, Kimi)                            | Tight feedback loop; expensive thinking is wasted                   |
| Code review / debugging diffs          | Strongest model on diff-only context           | Hard reasoning, but only on small token surface                     |
| Planning / discussion                  | Conductor model (any strong reasoning model)   | High-leverage decisions, run once                                   |

**Net effect:** instead of one Opus session burning $X on the entire project, you get one Conductor session ($Y on planning) + parallel implementers spending fractions of $X on routine tasks they're well-matched to. The Router enforces this with hard caps on per-provider, per-phase, and per-agent-session spend.

This is the user-facing **"why pay $20/mo for three subscriptions"** answer: MetaCLiDE turns those three idle subscriptions into a *team* that finishes one project faster and cheaper than any of them alone.

---

## 4. Connection Modes (How Agents Get Authenticated)

MetaCLiDE intentionally treats *how* an agent is reached as a separate concern from *what* the agent does. Every adapter exposes the same `Peer` interface; the auth/connection layer below it can be any of:

1. **OAuth subscription** — for tools that allow third-party OAuth (Codex CLI via OpenAI PKCE/device-code, Kimi via Moonshot device-code). MetaCLiDE implements these flows natively (no shelling out to `codex login`/`kimi login`) and stores tokens at the tool's standard locations (`~/.codex/auth.json`, `~/.kimi/credentials/kimi-code.json`). Background refresh runs at the appropriate intervals (Codex: when last refresh > 8 days; Kimi: when < 5 min to expiry).
2. **BYOK (Bring Your Own Key)** — direct API access via the provider's SDK. Used universally for Claude (Anthropic banned third-party OAuth in Jan 2026, so Claude is *always* BYOK), and as an option for Codex (OpenAI), Kimi (Moonshot), and any other provider.
3. **OpenAI-compatible endpoints** — the generic `OpenAiCompatPeer` accepts any `baseURL`. This covers OpenRouter, Groq, Together AI, DeepSeek, Azure OpenAI, Fireworks, and any future provider that exposes the OpenAI chat-completions schema.
4. **Localhost / self-hosted** — same `OpenAiCompatPeer` with `baseURL: http://localhost:11434/v1` (Ollama) or LM Studio's local server. Token cost is effectively zero, useful for iterating on cheap fix-loop tasks or fully offline operation.
5. **Plugin agents** — any custom CLI agent registered via `~/.metaclide/plugins/<id>/manifest.json` with its own `loginCommand`, `execCommand`, output format, and entrypoint. Adds a peer in <50 LOC.

The orchestration logic above the adapters never knows which mode is in use — it just sends `PeerMessage` events and reads back `PeerEvent` streams.

Credentials are stored in the **OS keychain** via `keytar` (macOS Keychain, Windows Credential Manager, libsecret on Linux), with a base64 file fallback at `~/.metaclide/credentials.json` if keytar's native module fails (common on Windows without build tools).

---

## 5. The Contract-First Collaboration Protocol

The hardest problem when multiple coding agents work in parallel is **the oscillation trap**: frontend invents `/getAllUsers`, backend implements `/users`, both "fix" by changing their own assumption, and they drift forever. MetaCLiDE's answer is a contract-first protocol with three components:

1. **Canonical contracts** — a small set of authoritative files in `.orch/contracts/`:
   - `api.openapi.yaml` — endpoints, methods, request/response schemas (OpenAPI 3.0)
   - `pages.routes.json` — frontend route map, components, connected endpoints
   - `entities.schema.json` — shared data models (JSON Schema)
   - `types.ts` — shared TypeScript interfaces
   - `db-schema.prisma` — DB schema
   - `decisions.md` — architecture decision records
   - `VERSION` — integer version, bumped on every accepted change request
2. **Freeze phases** — during parallel implementation, contracts are **read-only for everyone**. Only the Conductor can change them, and only via the formal change-request flow. Enforced by `LOCK.contracts` and a git tag (`contract-v1`, `contract-v1.1`, ...).
3. **Change Requests (CRs)** — peers can't modify contracts unilaterally. If a peer hits a gap, it writes a `CR-<id>.json` file describing what's missing and why. **All peers pause** (consensus pause), the Conductor decides ACCEPT/REJECT in one atomic step, the contract bumps version, peers re-ACK, then everyone resumes.

The handshake is strict: every peer must read `.orch/contracts/VERSION`, hash the contracts directory, and write `{contractVersion, contractHash}` to `.orch/status/<peer>.json` before it's allowed to receive an implementation task. If the version changes mid-run, the peer must re-ACK.

---

## 6. The Six-Phase Pipeline

When the user runs `metaclide run` (or hits `/run` in the TUI), the `OrchestrationRunner` (a single async generator that yields `OrchEvent`s for the UI to render) executes:

1. **Discussion** — implementers receive the brief in parallel and respond with their understanding, what they want to own, and any concerns. Outputs are concatenated into a "peer input" string fed to the Conductor.
2. **Planning** — the Conductor uses Codex's `--output-schema` (structured-output) feature to produce a strict-JSON `plan.json` of 2–6 tasks, each with `id, title, owner, acceptance, dependencies`. Owners are validated against the live peer list; if the model hallucinates an owner, MetaCLiDE round-robin-assigns it. The Conductor also drafts the contract files.
3. **Contract Review** — every peer (including the Conductor) gets the full contract bundle and replies ACK or REJECT-with-objections. Runs in parallel via a `fanIn` async-iterator merger. Conductor revises until consensus or a timeout forces a decision.
4. **Lock** — `LOCK.contracts` is written with the Conductor's session ID, the contract directory hash is recorded, and a git tag `contract-v<N>` is created. From this point on, contracts are read-only.
5. **Implementation** — every peer's tasks (grouped by `owner`) are dispatched in parallel, each peer writing in its own worktree at `.orch/worktrees/<peer-id>/` on branch `agent/<peer-id>`. The Router checks budget before each dispatch; over-budget peers are skipped with a warning. While peers run, MetaCLiDE polls `.orch/change-requests/`; any new CR triggers consensus pause, Conductor resolution, and contract version bump.
6. **Integration** — Conductor merges `agent/*` branches into an `integration` branch in dependency order, runs verification gates (lint, typecheck, unit tests, build, optional E2E smoke), runs mismatch detectors (API/schema/route/DB checks against contracts, not just compile-pass), and on failure dispatches **fix tasks** to the responsible peer. Bounded by 5 fix iterations or budget cap.
7. **Delivery** — emits an integration report, a cost summary by peer and provider, and leaves the user with a runnable project + a clean commit history.

A peer-crash in any parallel phase is isolated by `fanIn`: it surfaces as an error event but doesn't kill the rest of the team.

---

## 7. Architecture (Code Map)

```
src/
├── types.ts                       # Shared types: PeerConfig, Task, PlanFile, PeerEvent...
├── commands/                      # oclif commands — thin wrappers around lib/
│   ├── interactive.ts             # default: opens Ink TUI
│   ├── init.ts                    # scaffold .orch/
│   ├── connect.ts, agents/*.ts    # auth + peer registry management
│   ├── run.ts                     # non-interactive pipeline trigger
│   ├── status.ts, logs.ts         # observability
│   ├── resume.ts, export.ts       # crash recovery + zip/patch/PR export
│   └── doctor.ts                  # environment health check
├── tui/                           # React + Ink v5 TUI
│   ├── App.tsx                    # state machine: select_conductor → key → chat → orchestrate
│   ├── ConductorSelect.tsx        # arrow-key picker with green dot for active sessions
│   ├── ApiKeyInput.tsx            # masked key input
│   ├── ChatHistory.tsx, Message.tsx, Header.tsx, StatusBar.tsx
│   ├── conductor.ts               # streaming chat backend (Anthropic SDK / OpenAI SDK / CLI subprocess)
│   ├── AgentManager.tsx           # multi-peer status dashboard during /run
│   └── ConductorManager.tsx
└── lib/
    ├── orch/
    │   ├── index.ts               # OrchManager: CRUD over .orch/* with Zod validation
    │   ├── runner.ts              # OrchestrationRunner: 6-phase async-generator pipeline
    │   ├── schema.ts              # Zod schemas for every .orch file format
    │   ├── paths.ts               # path helpers
    │   └── sessions.ts            # peer session ID persistence (Claude session_id, Codex thread_id)
    ├── auth/
    │   ├── keychain.ts            # keytar + base64 file fallback
    │   ├── session.ts             # session detection (existing OAuth files), CLI detection
    │   ├── oauth-codex.ts         # PKCE :1455 + device code, token exchange, refresh
    │   └── oauth-kimi.ts          # device code, X-Msh-* headers, refresh
    ├── git/worktree.ts            # WorktreeManager (simple-git): create/remove/merge/tag/.orch symlink
    ├── contracts/
    │   ├── lock.ts                # LOCK.contracts + SHA-256 hash + ACK validation
    │   └── validation.ts          # mismatch detectors (API/schema/route/DB) + integration report
    ├── gates/index.ts             # lint, typecheck, test, build, e2e — parallel + sequential modes
    ├── router/index.ts            # in-process budget router (no proxy server)
    ├── logger/index.ts            # JSONL per-peer transcripts + multi-peer factory
    ├── peers/
    │   ├── interface.ts           # Peer contract: send(), ackContract(), writeStatus(), shutdown()
    │   ├── claude.ts              # ClaudePeer — @anthropic-ai/claude-agent-sdk query()
    │   ├── codex.ts               # CodexPeer — codex exec --json subprocess
    │   ├── kimi.ts                # KimiPeer — kimi --print subprocess + Moonshot API fallback
    │   ├── agentic.ts             # AgenticApiPeer — generic OpenAI-compatible tool loop (Kilocode-style)
    │   └── factory.ts             # PeerFactory + PluginProxy
    └── plugins/registry.ts        # plugin manifest loader for ~/.metaclide/plugins/<id>/

.orch/                             # all session state lives in the repo
├── brief.md, peers.json, plan.json, LOCK.contracts
├── contracts/                     # canonical specs (read-only after lock)
├── status/<peer>.json             # per-peer ACK + activity (peer writes only its own)
├── change-requests/CR-*.json
├── threads/T-*.md                 # human-readable discussion logs
├── logs/<peer>.jsonl              # structured per-agent transcripts
├── sessions/<peer>.json           # session ID persistence for resumption
├── integration-report.md
└── worktrees/<peer-id>/           # one git worktree per peer
```

Every async edge in the system is an `AsyncIterable<PeerEvent>` — peers stream events, the runner merges streams via a `fanIn` helper, and the TUI consumes the merged stream to render real-time multi-peer activity.

---

## 8. Peer Adapter Layer

There are four adapter types, all implementing the same `Peer` interface:

| Adapter             | Backs                                          | How it works                                                                     |
|---------------------|------------------------------------------------|----------------------------------------------------------------------------------|
| `ClaudePeer`        | Claude (Anthropic, BYOK only)                  | `@anthropic-ai/claude-agent-sdk` `query()` — full agent loop, tool gating via `canUseTool`, session resume via `session_id` |
| `CodexPeer`         | Codex CLI subprocess (OAuth or BYOK)           | `codex exec --json --full-auto --sandbox workspace-write`, NDJSON parsing (split on `}{` boundary, not `\n`), thread resume via `codex exec resume <id>` |
| `KimiPeer`          | Kimi CLI subprocess (OAuth or BYOK)            | `kimi --print -y -p <prompt> --output-format stream-json`, wire-protocol events |
| `AgenticApiPeer`    | Any OpenAI-compatible API (OpenRouter, Ollama, Moonshot, OpenAI, custom) | Self-hosted Kilocode-style tool loop: read/write/edit/bash, JSON tool-call parsing, max-turns guard |
| `PluginProxy`       | Any plugin manifest                            | Lazy-loads the real adapter on first `send()` so factory creation stays sync     |

`PeerFactory.create()` chooses the adapter based on `provider` + CLI availability + auth `mode`. The decision tree:
- `provider: anthropic` → `ClaudePeer` (always)
- `provider: openai` → `CodexPeer` if `codex` is on PATH, else `AgenticApiPeer`
- `provider: moonshot` → `KimiPeer` if `kimi` is on PATH, else `AgenticApiPeer` (with Moonshot baseURL)
- Anything else with a `baseURL` → `AgenticApiPeer` (handles OpenRouter / Ollama / etc.)
- Otherwise → `PluginProxy`

Every adapter handles auth, structured output, and tool gating in its own way, but the runner above never sees the difference.

---

## 9. Budget Enforcement & Token Economics

The Router (`src/lib/router/index.ts`) is a deliberately small, in-process module — **no proxy server, no LiteLLM, no extra dependencies.** It tracks usage and enforces three budget axes:

| Axis                | Example                              | Enforcement                                                |
|---------------------|--------------------------------------|------------------------------------------------------------|
| Per provider / day  | `$5 OpenAI, $3 Anthropic`            | Hard cap; over-budget peers get skipped with a warning     |
| Per agent / session | `$10 max per peer in this session`   | Soft → hard cap; pauses peer when exceeded                 |
| Per phase           | `$5 max during 'implement'`          | Hard cap across all peers in that phase                    |

Budget flags parse like `--budget anthropic=3,openai=5` and feed straight into the runner.

Cost recording happens at the boundary of every peer's `result` event — each adapter emits `{costUsd, turns}` based on the provider's actual usage data (Anthropic SDK gives `total_cost_usd` directly; Codex emits `usage.input_tokens / output_tokens` we multiply by Codex pricing; Kimi uses Moonshot's `$0.60/M input, $2.50/M output`).

For OAuth/tool-backed peers where exact $ isn't always available, MetaCLiDE falls back to **proxy budgets**: max iterations per phase, max prompt length, per-task timeouts. These are coarser but still bounded.

The savings story: a typical 2-peer session (Claude conductor + Kimi implementer) on a moderate full-stack project comes in at a small fraction of a single-Claude session, because Kimi handles 60–80% of the implementation tokens at 1/10 the price, and Claude is reserved for planning + integration review. Add a third peer routed via OpenRouter to a Haiku-class model for fix-loop iterations and the cost curve flattens further.

---

## 10. The Terminal UI

MetaCLiDE's interactive mode is **React + Ink v5** — a Claude Code-style experience that renders in the normal terminal flow (no alternate screen buffer, so native scrollback, text selection, and search all work). The component tree:

```
<App>
  <Header />              project, conductor, model, phase
  <ChatHistory>           streaming, markdown-rendered
    <Message peer="claude" />   colored agent label when multiplexing
    <ToolUseBlock />            spinner + status transitions
  </ChatHistory>
  <InputField />          multi-line, Shift+Enter
  <StatusBar>             active peers, token usage, slash command hint
    <AgentManager />      live per-peer status during /run
  </StatusBar>
</App>
```

The default flow:
1. Pick conductor (arrow-key menu, green dot for active OAuth sessions detected on disk)
2. Resolve auth (env → keychain → masked prompt; OAuth flow inline if needed)
3. Chat with the Conductor multi-turn — the Conductor uses tool-calls to write `.orch/brief.md` from the conversation
4. Hit `/run` to launch the orchestration pipeline; the TUI flips into the multi-peer dashboard rendering live `OrchEvent`s

Slash commands handled locally (don't go to the model): `/run`, `/status`, `/logs`, `/connect`, `/sessions`, `/new`, `/compact`, `/help`, `/exit`.

Sessions persist as JSONL at `~/.metaclide/sessions/<workspace-hash>/<uuid>/` (context, wire log, state) and are resumable via `metaclide --continue` or `metaclide --session <id>`.

---

## 11. Tech Stack

| Layer                   | Choice                                                              |
|-------------------------|---------------------------------------------------------------------|
| Language / runtime      | TypeScript (ESM, NodeNext), Node.js ≥20                             |
| CLI framework           | oclif v4 (subcommands, plugin support, cross-platform packaging)    |
| Terminal UI             | React + Ink v5, ink-text-input, ink-spinner, ink-select-input       |
| Process control         | execa (non-PTY subprocess management)                               |
| Git                     | simple-git (worktrees, branches, merges, tags)                      |
| Schema validation       | Zod (every `.orch` file has a Zod schema; runtime validation)       |
| Contract formats        | OpenAPI 3.0, JSON Schema, Prisma DSL, raw TypeScript                |
| Key storage             | keytar (OS keychain) with base64 file fallback                      |
| Auth (OAuth)            | RFC 7636 PKCE (Codex browser) + RFC 8628 device code (Codex/Kimi)   |
| Provider SDKs           | `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `openai`     |
| Logging                 | JSONL per-peer transcripts, structured event records                |
| Testing                 | Vitest (101 tests across 11 files; orch, contracts, router, factory, sessions, validators) |
| Packaging               | oclif pack (Windows + macOS binaries; Linux planned)                |

Total surface today: **~36 source files**, all building clean under `tsc --strict`.

---

## 12. Implementation Status

**Working end-to-end:**
- Full pipeline: discussion → planning → contract lock → parallel implementation → integration → delivery
- All 11 CLI commands (`init`, `connect`, `agents`, `agents add/remove`, `run`, `status`, `logs`, `resume`, `export`, `doctor`, `interactive`)
- TUI with 9 slash commands including live multi-agent dashboard
- Codex/Kimi OAuth flows (PKCE browser + device code), Claude BYOK
- Plugin install + plugin proxy peer
- Budget enforcement across all three axes
- Contract version bump on CR acceptance, consensus pause on mid-flight CR
- Mismatch auto-CR generation with conductor resolution
- Auth validation test call before orchestration starts
- Retry with exponential backoff on peer failures
- Session persistence (TUI sessions + per-peer Claude/Codex thread IDs)
- Crash recovery via `runner-state.json`
- Export as zip / patch / PR-via-`gh`
- Mismatch detectors (API, schema, route, DB) — fully implemented, not stubs
- 101 vitest tests passing

**Known gaps (roadmap):**
- E2E test against real, billed agents (currently mocked at the SDK boundary)
- Binary packaging via `oclif pack` (scripts exist but untested on a fresh machine)
- Capability-based routing in `Router.selectPeer()` is still a naive "pick first implementer" — the model-class routing described in §3 is the spec direction, not yet wired into automatic task assignment (it's done by the Conductor's plan today, not by hard rules in the Router)
- BYOK "MetaCLiDE-as-its-own-agent" peer (Kilocode-style coding loop with our own tool definitions) — partly built as `AgenticApiPeer`, can be promoted to a first-class peer once stabilized

Status as of latest spec review: **~98% spec-compliant**.

---

## 13. Key Invariants (the rules the system never breaks)

1. **Contracts are the truth.** Implementation must conform to `.orch/contracts/*`, not the other way around.
2. **Only the Conductor edits contracts.** All other peers propose via CRs.
3. **Every peer must ACK** the current contract version + hash before receiving implementation tasks.
4. **Consensus pause is global.** When a CR is filed, *all* peers halt — regardless of how many peers there are.
5. **One worktree per peer.** No peer ever writes to another peer's branch or to the integration branch directly.
6. **Mismatches auto-generate CRs.** The Conductor resolves them once; peers conform.
7. **Fix loop is bounded.** Max 5 iterations or the budget cap, whichever hits first.
8. **No bilateral negotiation.** Peers never directly negotiate with each other — everything goes through the Conductor or the contract.
9. **Peer count is runtime config.** Core orchestration never hardcodes 2, 3, or any fixed number of peers.
10. **Anything OpenAI-compatible can become a peer** via `baseURL` + plugin manifest. No core changes required.

---

## 14. What Makes This Hard (And How It's Solved)

| Challenge                                            | Solution                                                                                     |
|------------------------------------------------------|----------------------------------------------------------------------------------------------|
| **Oscillation:** peers endlessly editing each other's code | Contract freeze during parallel phases + Conductor-mediated CRs                              |
| **Heterogeneous I/O:** every CLI emits a different format  | Codex NDJSON without trailing newlines (split on `}{`); Kimi wire protocol via JSON-RPC; Claude SDK events. All normalized to one `PeerEvent` stream. |
| **Auth policy drift:** Anthropic banned third-party OAuth mid-build | BYOK-only path for Claude; OAuth still works for Codex/Kimi; plugin agents bring their own |
| **Concurrent state writes** to shared `.orch/`             | Strict per-peer status file ownership; Conductor exclusivity on contracts; SHA-256 hashing to detect drift |
| **Budget overruns** during long runs                       | Per-provider/per-phase/per-session caps in the Router with hard skip behavior                |
| **Crash mid-pipeline**                                     | `runner-state.json` persistence + `metaclide resume` re-enters at the right phase            |
| **Sandbox differences** across CLIs                        | `--sandbox workspace-write` for Codex; `acceptEdits` for Claude; `--yolo` for Kimi; bash gating in adapter for risky commands (`git push`, `rm -rf`, `npm publish`, `curl … deploy`) |
| **Peer crash isolation**                                   | `fanIn` async-iterator merger surfaces a single peer's exception as an error event without killing the rest of the team |
| **Long contracts → high token cost on every review**       | Review prompts include the contract bundle once; subsequent multi-turn uses session resumption (Claude `session_id`, Codex `thread_id`) so providers don't re-bill the same prefix |

---

## 15. Where This Lives in the Tooling Landscape

MetaCLiDE is intentionally **not**:
- An agent framework (LangChain, AutoGen, CrewAI). Those build agents from primitives. MetaCLiDE orchestrates *finished, autonomous coding agents*.
- A model router (OpenRouter, LiteLLM proxy). Those swap one model for another behind a single endpoint. MetaCLiDE runs *multiple full agent products in parallel* and coordinates their work.
- A coding agent itself. It doesn't read/write/edit files directly. It tells Claude Code, Codex, Kimi (or any plugin agent) to do that, and merges their results.
- A replacement for any of those agents. They each remain fully functional standalone; MetaCLiDE is the layer above that lets them collaborate.

Closest analog: **a build system + CI for AI coding agents.** The contracts are the build interfaces. The worktrees are the build sandboxes. The verification gates are the CI checks. The CR flow is the change-management process. The Conductor is the tech lead.

---

## 16. Summary in Three Sentences

MetaCLiDE turns the user's existing multi-subscription mess into a coordinated team: 2+ AI coding agents work in parallel on isolated git worktrees, governed by a contract-first protocol that prevents the oscillation problem, with every task routed to the cheapest model capable of doing it well. Connection mode is a non-issue — OAuth, BYOK, OpenRouter, and localhost endpoints all flow through the same `Peer` interface — so the orchestration logic stays the same whether the team is "Claude Pro + Codex Pro" or "Claude API + Ollama + DeepSeek via OpenRouter". The result is a working full-stack project, delivered for a fraction of the token cost of a single top-tier model carrying the whole load.
