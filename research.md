# MetaCLiDE — What This Project Is

## The Core Idea

MetaCLiDE is a terminal CLI that sits above AI coding agent tools and makes them work together on one project. It doesn't replace Claude Code, Codex CLI, or Kimi Code — it controls them as subprocesses, coordinating their work so they collaborate like a team of developers.

## The Problem It Solves

Users pay for multiple AI coding subscriptions (ChatGPT Plus, Kimi, Claude) but can only use them one at a time. There's no way to make these tools talk to each other or split work between them. MetaCLiDE fixes this by orchestrating them — each tool works in its own git worktree on its own tasks, guided by shared contracts that prevent conflicts.

## How It Works (Conceptually)

1. User connects their existing subscriptions via OAuth (ChatGPT Plus → Codex CLI, Kimi subscription → Kimi CLI, Claude → API key)
2. MetaCLiDE spawns these CLI tools as subprocesses in isolated git worktrees
3. A conductor agent plans the work, writes contracts (API specs, routes, schemas), and assigns tasks
4. All agents review and acknowledge contracts before coding starts
5. Agents implement in parallel, each in their own branch
6. MetaCLiDE merges their work, runs verification, and delivers the result

## What MetaCLiDE Is NOT

- **Not an API wrapper** — it controls real CLI coding agents, not raw model APIs
- **Not a coding agent itself** — it orchestrates existing agents, doesn't do the coding
- **Not a model router** — it doesn't pick which model to call; it manages full autonomous coding tools
- **Not competing with Claude Code/Codex/Kimi** — it makes them more valuable by enabling collaboration

## The Key Insight

Claude Code, Codex CLI, and Kimi Code are each full autonomous agents — they read files, write code, run commands, and reason about tasks. MetaCLiDE treats them as "peers" (like developers on a team) and coordinates their work through a contract-first protocol that prevents the oscillation problem where agents endlessly revise each other's output.

## Primary Mode: Subscription-Based

The primary use case is OAuth/subscription. Users leverage subscriptions they already pay for. MetaCLiDE authenticates via OAuth device code flows, then spawns the CLI tools which read their own credential files. No API keys needed for the core workflow.

BYOK (bring your own API key) is a secondary feature for later — it would require MetaCLiDE to run its own agentic tool loop (like Kilo Code does), which is a bigger scope.

## The Agents We Control

| Agent | How We Control It | Auth |
|-------|------------------|------|
| Codex CLI | `codex exec --json --full-auto` subprocess, NDJSON event stream | OAuth (ChatGPT Plus/Pro) or API key |
| Kimi Code CLI | `kimi --print -y -p "<prompt>" --output-format stream-json` subprocess | OAuth (Kimi subscription) or API key |
| Claude Code | `@anthropic-ai/claude-agent-sdk` query() API or `claude -p` subprocess | API key only (Anthropic doesn't allow third-party OAuth) |

## BYOK Mode (Future Feature)

BYOK is **not a fallback**. It's a peer agent mode where MetaCLiDE itself becomes a coding agent — a peer alongside Codex and Kimi. Just like `codex exec` runs as a subprocess peer, MetaCLiDE would run its own coding agent process as a peer, powered by whatever API key the user provides.

The difference:
- **Codex CLI** knows how to code because OpenAI built it that way
- **Kimi CLI** knows how to code because Moonshot built it that way
- **MetaCLiDE's BYOK peer** would know how to code because **we build it that way** — our own agentic tool loop (read/write/edit/bash) similar to Kilo Code CLI

This is a later feature because it means building our own terminal coding agent, not just orchestrating existing ones.

## Reference: Kilo Code CLI

Kilo Code CLI (`@kilocode/cli`) is the terminal-based open-source coding agent from Kilo-Org. It's the reference for how MetaCLiDE's BYOK peer should work.

---

## Research Findings (March 2026)

### Claude Code Internals

- Built with Bun + CommanderJS + React Ink for terminal rendering
- Core agent loop (codenamed "nO"): send prompt → model responds with tool_use blocks → execute tools locally → feed results back → repeat until done
- ~92% prefix cache reuse rate across API calls (system prompt + history cached)
- Can spawn sub-agents (`dispatch_agent`) but depth-limited to 1 level
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): `query()` returns an AsyncGenerator yielding SDKMessage events (system/init, assistant, result)
- Key SDK options: `cwd`, `allowedTools`, `permissionMode`, `maxTurns`, `maxBudgetUsd`, `resume`, `canUseTool`, `effort`, `systemPrompt` (can use preset + append), `hooks`, `agents`
- Permission modes: `default` (prompts), `acceptEdits` (auto file ops), `bypassPermissions` (all), `plan` (no exec), `dontAsk` (deny unlisted)
- SDK supports `enableFileCheckpointing` + `rewindFiles()` for rolling back changes
- **Auth limitation**: SDK only works with API keys. OAuth/subscription tokens are scoped to Claude Code CLI only — third-party tools get "not authorized" errors. Users with Max subscriptions must use the CLI subprocess fallback (`claude -p`)
- Session resume: `resume: "session-uuid"`, `forkSession: true` for branching without corrupting original
- CLI output formats: `text` (default), `json` (single object), `stream-json` (NDJSON with system/assistant/result events)

### Codex CLI Internals

- **Repo**: github.com/openai/codex — rewritten in Rust (codex-rs/), ~96.5% Rust
- Workspace crates: `core/` (business logic), `exec/` (headless CLI), `tui/` (Ratatui terminal UI), `cli/` (dispatcher)
- Event-driven agent loop via tokio async channels: `spawn_thread_listener()` sends `ThreadEventEnvelope` through unbounded channel
- In `exec` mode, all elicitation requests (user prompts) are auto-cancelled — fully autonomous
- **NDJSON events** (8 types): `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`
- **Item types** (10 variants): `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`
- Event structure can have item data nested in an `item` object or flat at top level — parsers need to handle both
- **Sandbox** (platform-specific):
  - macOS: Apple Seatbelt (`sandbox-exec`) — read-only jail except `$PWD`, `$TMPDIR`, `~/.codex`; network fully blocked
  - Linux: Landlock LSM + seccomp + iptables/ipset
  - Windows: Native sandbox isolation
- Sandbox modes: `read-only` (default for exec), `workspace-write`, `danger-full-access`
- **Correct CLI flags**: `--full-auto` (shortcut for `--ask-for-approval on-request` + `--sandbox workspace-write`), NOT `--approval-policy`
- Resume: `codex exec resume <thread_id> "follow-up" --json`
- Useful flags: `--ephemeral` (skip session persistence), `--skip-git-repo-check`, `-m <model>`
- Auth: `CODEX_API_KEY` env var, `~/.codex/auth.json` (OAuth), `codex login --device-auth`

### Kimi Code CLI Internals

- **Repo**: github.com/MoonshotAI/kimi-cli — Python-based (`pip install kimi-cli`)
- Full autonomous agent: reads/edits files, executes shell commands, searches web, plans multi-step tasks
- **CLI flags for subprocess control**:
  - `--print`: non-interactive mode, auto-exits, implicitly enables `--yolo`
  - `-y` / `--yolo` / `--auto-approve`: auto-approve all tool actions
  - `-p <prompt>`: supply task prompt on command line
  - `--work-dir <path>` / `-w`: set root directory for file operations
  - `--output-format stream-json`: JSONL output using Wire protocol
  - `-m <model>`: override model
  - `--session <id>` / `--continue`: session resumption
  - `--max-steps-per-turn`: limit agent steps
- **Wire protocol events**: `StatusUpdate`, `TurnBegin`/`TurnEnd`, `ApprovalRequest`, `QuestionRequest`, `ContentPart`
- **API**: `api.moonshot.ai/v1` (international), `api.moonshot.cn/v1` (China) — OpenAI-compatible, works with standard `openai` npm package
- **Models**: `kimi-k2` (general), `kimi-k2-thinking-turbo` (complex reasoning), `kimi-coding-k2.5` (code specialization) — all 256K context
- **Pricing**: $0.60/M input, $2.50/M output (roughly 10x cheaper than Claude Sonnet)
- **Auth**: OAuth device code flow via `/login` command (credentials at `~/.kimi/credentials/kimi-code.json`), or `KIMI_API_KEY`/`MOONSHOT_API_KEY` env var

### Kilo Code CLI (Terminal Coding Agent — Reference for BYOK Peer)

- **Repo**: github.com/Kilo-Org/kilocode — TypeScript monorepo, CLI at `packages/cli`
- Fork of [OpenCode](https://opencode.ai/docs/cli/) enhanced with Kilo platform integrations
- **Install**: `npm install -g @kilocode/cli` or `npx @kilocode/cli`

**CLI Commands:**
| Command | Purpose |
|---------|---------|
| `kilo` | Launch interactive TUI |
| `kilo run "prompt"` | Non-interactive single-shot execution |
| `kilo serve` | Headless HTTP server (port 4096) |
| `kilo session` | List/manage sessions |
| `kilo models [provider]` | List available models |
| `kilo stats` | Token usage + cost |

**Key Flags for Subprocess Control:**
| Flag | Effect |
|------|--------|
| `--auto` | Autonomous mode — auto-approves all tool calls |
| `--format json` | Streams JSON events to stdout (no TUI) |
| `--model` / `-m` | Select provider/model, e.g. `anthropic/claude-sonnet-4` |
| `--agent` | Agent mode: `coder`, `architect`, `debug`, `ask`, `orchestrator` |
| `--session` / `-s` | Resume specific session |
| `--continue` / `-c` | Resume most recent session |
| `--fork` | Branch from existing session |

**BYOK Configuration** — three ways:
1. **Config file** (`~/.config/kilo/opencode.json` or `./opencode.json`):
   ```json
   {
     "model": "anthropic/claude-sonnet-4",
     "provider": {
       "anthropic": { "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" } },
       "custom": {
         "npm": "@ai-sdk/openai-compatible",
         "options": { "baseURL": "https://api.moonshot.ai/v1", "apiKey": "{env:MOONSHOT_API_KEY}" }
       }
     }
   }
   ```
2. **Environment variables**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `KILO_PROVIDER`, `KILO_API_KEY`
3. **Interactive `/connect`** command in TUI

**JSON Output Events** (`--format json`):
- `message.part.delta` — incremental text chunks
- `message.part.updated` — complete message part
- `message.created` — new message
- `session.updated` — session state change
- `tool.call` — tool execution started
- `error` — error

**Tools Exposed to LLM:**
`read_file`, `write_to_file`, `apply_diff`, `fast_edit_file`, `list_files`, `search_files`, `execute_command`, `browser_action`, `use_mcp_tool`

**Agent Loop** (`recursivelyMakeClineRequests()` in Task class):
1. Send conversation + tool definitions to LLM
2. Parse tool calls from response (native tool_use or XML format)
3. Validate against permissions (mode-based + path-based via `.kiloignore`)
4. Execute tool locally, capture result
5. Feed result back into conversation
6. Repeat until task complete or max turns

**Permission System:**
```json
{
  "permission": {
    "bash": { "*": "ask", "git *": "allow", "rm *": "deny" },
    "edit": { "*": "deny", "src/**": "allow" }
  }
}
```
With `--auto`, all permissions auto-approved.

**Session Management:** SQLite-based persistence. Resume via `--continue` or `--session <id>`. Fork, export (JSON), import supported.

**Three Headless Modes:**
1. `kilo run --auto --format json` — single-shot, JSON events on stdout
2. `kilo serve` — HTTP REST API + SSE on port 4096 (full API: create session, send prompt, stream events, abort, fork)
3. JSON-IO mode — bidirectional JSON over stdin/stdout (used by VS Code extension to control CLI as subprocess)

**Why This Matters for MetaCLiDE:**
When we build the BYOK peer, it will be our own coding agent tool — similar to how Kilo CLI works. It runs as a subprocess peer alongside Codex CLI and Kimi CLI. The user provides an API key for any provider, and MetaCLiDE's BYOK peer uses it to do agentic coding (read/write/edit/bash loop). Kilo CLI's architecture (especially `kilo run --auto --format json` for subprocess control, and the permission system) is the reference implementation.
