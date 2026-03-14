import React, {useState, useCallback, useEffect, useRef} from 'react'
import {Box, Text, useApp, useInput} from 'ink'
import TextInput from 'ink-text-input'
import SelectInput from 'ink-select-input'
import {Header} from './Header.js'
import {ChatHistory} from './ChatHistory.js'
import {StatusBar} from './StatusBar.js'
import {SlashMenu, getFilteredCommands} from './SlashMenu.js'
import {PeerStatusPanel, type PeerDisplayStatus} from './PeerStatusRow.js'
import {ConductorSelect, type ConductorChoice} from './ConductorSelect.js'
import {ApiKeyInput} from './ApiKeyInput.js'
import {ConductorChat} from './conductor.js'
import {OrchManager} from '../lib/orch/index.js'
import {OrchestrationRunner} from '../lib/orch/runner.js'
import {getCredential, storeCredential} from '../lib/auth/keychain.js'
import {getCodexApiKey, hasCodexOAuthSession, loginCodexBrowser, loginCodexDevice} from '../lib/auth/oauth-codex.js'
import {getKimiAccessToken, loginKimiDevice} from '../lib/auth/oauth-kimi.js'
import {type MessageData, peerColor} from './Message.js'
import {
  createSession, updateSession, appendMessage, loadMessages, loadState,
  listSessions, autoTitle, type SessionState,
} from '../lib/tui-sessions/index.js'
import {AgentManager, type AgentEntry} from './AgentManager.js'
import {ConductorManager, type ConductorSelection} from './ConductorManager.js'
import {hasCodexOAuthSession as _hasCodexSub} from '../lib/auth/oauth-codex.js'
import {hasKimiSession as _hasKimiSub} from '../lib/auth/oauth-kimi.js'
import {detectInstalledCLIs, BUILT_IN_AGENTS} from '../lib/auth/session.js'
import type {PeerConfig} from '../types.js'

type Phase =
  | 'select_conductor'
  | 'enter_key'
  | 'oauth_login'
  | 'chat'
  | 'conductor_config'   // replaces old model_select — full provider+model picker
  | 'orchestrating'

const PROVIDER_ENV: Record<string, {envVar: string; keychainId: string}> = {
  anthropic: {envVar: 'ANTHROPIC_API_KEY', keychainId: 'anthropic'},
  openai: {envVar: 'OPENAI_API_KEY', keychainId: 'openai'},
  moonshot: {envVar: 'MOONSHOT_API_KEY', keychainId: 'moonshot'},
}

interface AppProps {
  repoRoot: string
  orch: OrchManager
  onExit: () => void
  resumeSessionId?: string
}

let msgCounter = 0
function nextId() { return `msg-${++msgCounter}` }

const PEER_COLORS_LIST = ['cyan', 'green', 'magenta', 'yellow', 'blue', 'white']

export function App({repoRoot, orch, onExit, resumeSessionId}: AppProps) {
  const {exit} = useApp()
  const [phase, setPhase] = useState<Phase>('select_conductor')
  const [conductor, setConductor] = useState<ConductorChoice | null>(null)
  const [chat, setChat] = useState<ConductorChat | null>(null)
  const [messages, setMessages] = useState<MessageData[]>([])
  const [inputValue, setInputValue] = useState('')
  const [loading, setLoading] = useState(false)
  const [projectName, setProjectName] = useState(() => orch.readProjectName() || '')
  const [oauthStatus, setOauthStatus] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionList, setSessionList] = useState<SessionState[]>([])
  const [showSessions, setShowSessions] = useState(false)
  const [showAgents, setShowAgents] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const titledRef = useRef(false)

  const buildAgentEntries = useCallback((): AgentEntry[] => {
    const peers = orch.readPeers()?.peers ?? []
    const clis = detectInstalledCLIs()
    const codexSub = _hasCodexSub()
    const kimiSub = _hasKimiSub()

    // Check env vars for BYOK keys
    const hasAnthropicEnv = !!process.env.ANTHROPIC_API_KEY?.trim()
    const hasOpenaiEnv = !!process.env.OPENAI_API_KEY?.trim()
    const hasMoonshotEnv = !!(process.env.KIMI_API_KEY?.trim() || process.env.MOONSHOT_API_KEY?.trim())

    // Start from configured peers, augment with detection
    const allIds = new Set([
      ...peers.map(p => p.id),
      ...BUILT_IN_AGENTS.map(a => a.id),
    ])

    return [...allIds].map(id => {
      const peerCfg = peers.find(p => p.id === id)
      const builtIn = BUILT_IN_AGENTS.find(a => a.id === id)
      const provider = peerCfg?.provider ?? builtIn?.provider ?? id

      let authStatus: AgentEntry['authStatus'] = 'none'
      if (id === 'claude') {
        authStatus = (hasAnthropicEnv || peerCfg?.apiKey) ? 'apikey' : 'none'
      } else if (id === 'codex') {
        authStatus = codexSub ? 'subscription' : (hasOpenaiEnv || peerCfg?.apiKey) ? 'apikey' : 'none'
      } else if (id === 'kimi') {
        authStatus = kimiSub ? 'subscription' : (hasMoonshotEnv || peerCfg?.apiKey) ? 'apikey' : 'none'
      } else if (peerCfg?.apiKey) {
        authStatus = 'apikey'
      }

      return {
        id,
        displayName: peerCfg?.displayName ?? builtIn?.displayName ?? id,
        provider: provider as AgentEntry['provider'],
        mode: peerCfg?.mode ?? 'byok',
        authStatus,
        cliInstalled: clis[id] ?? false,
        currentModel: peerCfg?.model,
        role: peerCfg?.role ?? 'implementer',
        configured: !!peerCfg,
      } satisfies AgentEntry
    })
  }, [orch])

  // Orchestrating phase state
  const [orchPhase, setOrchPhase] = useState('')
  const [peerStatuses, setPeerStatuses] = useState<PeerDisplayStatus[]>([])
  const orchAbortRef = useRef<boolean>(false)

  // Build peer color map from peers.json
  const getPeerColorMap = useCallback((): Record<string, string> => {
    const peers = orch.readPeers()?.peers ?? []
    const map: Record<string, string> = {}
    peers.forEach((p, i) => {
      map[p.id] = PEER_COLORS_LIST[i % PEER_COLORS_LIST.length]
    })
    return map
  }, [orch])

  const resolveKey = useCallback(async (provider: string): Promise<string | null> => {
    const cfg = PROVIDER_ENV[provider]
    if (!cfg) return null
    const envKey = process.env[cfg.envVar]?.trim()
    if (envKey) return envKey
    const stored = await getCredential(cfg.keychainId)
    return stored?.trim() || null
  }, [])

  const startChat = useCallback((choice: ConductorChoice, apiKey?: string, resumeId?: string) => {
    const c = new ConductorChat({provider: choice.provider, mode: choice.mode, apiKey, repoRoot, orch})
    setConductor(choice)
    setChat(c)
    titledRef.current = false

    // Session persistence
    if (resumeId) {
      // Restore previous session
      const prior = loadMessages(repoRoot, resumeId)
      const state = loadState(repoRoot, resumeId)
      setSessionId(resumeId)
      setMessages(prior.length > 0 ? prior : [{
        id: nextId(), role: 'system',
        content: `Resumed session: ${state?.title ?? resumeId}`,
      }])
      if (state?.projectName) setProjectName(state.projectName)
    } else {
      // New session
      const sess = createSession(repoRoot, {
        conductorProvider: choice.provider,
        conductorMode: choice.mode,
        conductorDisplayName: choice.displayName,
        projectName: orch.readProjectName() || '',
        title: 'New session',
      })
      setSessionId(sess.id)
      const brief = orch.readBrief()
      const hasContent = brief && !brief.includes('<!-- Brief will be written')
      const welcome: MessageData = {
        id: nextId(), role: 'system',
        content: hasContent
          ? 'Brief loaded. Type your message, /run to start agents, or /help for commands.'
          : 'Tell me what you want to build — describe your project.',
      }
      appendMessage(repoRoot, sess.id, welcome)
      setMessages([welcome])
    }

    setPhase('chat')
  }, [repoRoot, orch])

  const handleConductorSelect = useCallback(async (choice: ConductorChoice) => {
    if (choice.mode === 'oauth') {
      if (choice.provider === 'openai') {
        // Check for existing subscription session first (preferred over API key)
        if (hasCodexOAuthSession()) { startChat(choice, '__oauth_session__'); return }
        const existing = getCodexApiKey()
        if (existing) { startChat(choice, existing); return }
      } else if (choice.provider === 'moonshot') {
        const existing = getKimiAccessToken()
        if (existing) { startChat(choice, existing); return }
      }

      setConductor(choice)
      setPhase('oauth_login')
      setOauthStatus('Starting login...')

      try {
        let apiKey: string
        if (choice.provider === 'openai') {
          // Default: subscription mode — codex exec uses ChatGPT subscription credits
          try {
            apiKey = await loginCodexBrowser(e => setOauthStatus(e.message), {mode: 'subscription'})
          } catch {
            setOauthStatus('Browser flow unavailable, using device code...')
            apiKey = await loginCodexDevice(e => setOauthStatus(e.message), {mode: 'subscription'})
          }
        } else {
          apiKey = await loginKimiDevice(e => setOauthStatus(e.message))
        }
        startChat(choice, apiKey)
      } catch (err) {
        setOauthStatus('')
        setPhase('select_conductor')
        setMessages([{id: nextId(), role: 'system', content: `OAuth login failed: ${err instanceof Error ? err.message : String(err)}`}])
      }
      return
    }

    const key = await resolveKey(choice.provider)
    if (key) {
      startChat(choice, key)
    } else {
      setConductor(choice)
      setPhase('enter_key')
    }
  }, [resolveKey, startChat])

  const handleApiKey = useCallback(async (key: string) => {
    if (!conductor) return
    const cfg = PROVIDER_ENV[conductor.provider]
    if (cfg) await storeCredential(cfg.keychainId, key)
    startChat(conductor, key)
  }, [conductor, startChat])

  // ── Resume on mount ──
  useEffect(() => {
    if (!resumeSessionId) return
    const state = loadState(repoRoot, resumeSessionId)
    if (!state) return
    const choice: ConductorChoice = {
      provider: state.conductorProvider as 'anthropic' | 'openai' | 'moonshot',
      mode: state.conductorMode as 'byok' | 'oauth',
      displayName: state.conductorDisplayName,
    }
    // Resolve key and start chat with resume
    const cfg = PROVIDER_ENV[state.conductorProvider]
    if (cfg) {
      getCredential(cfg.keychainId).then(key => {
        startChat(choice, key ?? undefined, resumeSessionId)
      }).catch(() => {
        startChat(choice, undefined, resumeSessionId)
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Orchestration launcher ──
  const startOrchestration = useCallback(async () => {
    const peersFile = orch.readPeers()
    if (!peersFile || peersFile.peers.length < 2) {
      setMessages(prev => [...prev, {
        id: nextId(), role: 'system',
        content: 'Need at least 2 agents. Use `metaclide agents add` to add agents, then /run again.',
      }])
      return
    }

    // Resolve API keys
    const selectedPeers: PeerConfig[] = []
    for (const peer of peersFile.peers) {
      if (peer.mode === 'byok' && !peer.apiKey) {
        const key = await getCredential(peer.id)
        if (key) peer.apiKey = key
      }
      selectedPeers.push(peer)
    }

    const colorMap = getPeerColorMap()

    // Initialize peer status rows
    setPeerStatuses(selectedPeers.map((p, i) => ({
      peerId: p.id,
      displayName: p.displayName,
      status: 'idle',
      detail: 'waiting...',
      color: PEER_COLORS_LIST[i % PEER_COLORS_LIST.length],
    })))

    setPhase('orchestrating')
    setOrchPhase('starting')
    orchAbortRef.current = false

    setMessages([{id: nextId(), role: 'system', content: `Starting ${selectedPeers.length}-agent session...`}])

    const runner = new OrchestrationRunner()

    // Run in background — don't await, stream events into state
    ;(async () => {
      try {
        for await (const event of runner.run({
          repoRoot,
          selectedPeers,
          conductorId: peersFile.conductor,
        })) {
          if (orchAbortRef.current) break

          switch (event.type) {
            case 'phase':
              setOrchPhase(event.phase)
              setMessages(prev => [...prev, {
                id: nextId(), role: 'system',
                content: `── ${event.message} ──`,
              }])
              // Mark all peers as 'thinking' on new phase
              setPeerStatuses(prev => prev.map(p => ({...p, status: 'thinking', detail: event.phase})))
              break

            case 'log':
              setMessages(prev => [...prev, {id: nextId(), role: 'system', content: event.message}])
              break

            case 'peer_event': {
              const e = event.peerEvent
              const color = colorMap[event.peerId] ?? 'white'

              if (e.type === 'text' && e.content?.trim()) {
                setMessages(prev => {
                  // Append to last message from same peer if it's streaming, else new message
                  const last = prev[prev.length - 1]
                  if (last?.role === 'agent' && last.peerId === event.peerId && last.streaming) {
                    return prev.map(m => m.id === last.id
                      ? {...m, content: m.content + (e.content ?? '')}
                      : m
                    )
                  }
                  return [...prev, {
                    id: nextId(), role: 'agent' as const,
                    content: e.content ?? '',
                    peerId: event.peerId,
                    peerColor: color,
                    streaming: true,
                  }]
                })
                setPeerStatuses(prev => prev.map(p =>
                  p.peerId === event.peerId
                    ? {...p, status: 'working', detail: (e.content ?? '').slice(0, 55)}
                    : p
                ))
              } else if (e.type === 'tool_use') {
                // End any streaming message
                setMessages(prev => prev.map(m =>
                  m.peerId === event.peerId && m.streaming ? {...m, streaming: false} : m
                ))
                setMessages(prev => [...prev, {
                  id: nextId(), role: 'tool',
                  content: `${e.toolName}${e.toolInput && typeof e.toolInput === 'object' && 'path' in (e.toolInput as object) ? ` ${(e.toolInput as {path: string}).path}` : ''}`,
                  toolName: e.toolName,
                  peerId: event.peerId,
                  peerColor: color,
                }])
                setPeerStatuses(prev => prev.map(p =>
                  p.peerId === event.peerId ? {...p, status: 'working', detail: `⚙ ${e.toolName}`} : p
                ))
              } else if (e.type === 'result') {
                setMessages(prev => prev.map(m =>
                  m.peerId === event.peerId && m.streaming ? {...m, streaming: false} : m
                ))
                setPeerStatuses(prev => prev.map(p =>
                  p.peerId === event.peerId ? {...p, status: 'done', detail: `✓ done${e.costUsd ? ` $${e.costUsd.toFixed(4)}` : ''}`} : p
                ))
              } else if (e.type === 'error') {
                setPeerStatuses(prev => prev.map(p =>
                  p.peerId === event.peerId ? {...p, status: 'error', detail: e.error ?? 'error'} : p
                ))
                setMessages(prev => [...prev, {
                  id: nextId(), role: 'system',
                  content: `[${event.peerId}] Error: ${e.error}`,
                }])
              }
              break
            }

            case 'peer_phase':
              setPeerStatuses(prev => prev.map(p =>
                p.peerId === event.peerId ? {...p, detail: event.status} : p
              ))
              break

            case 'contract_locked':
              setMessages(prev => [...prev, {
                id: nextId(), role: 'system',
                content: `✓ Contracts locked v${event.version} (${event.hash.slice(0, 8)})`,
              }])
              break

            case 'gate_result': {
              const icon = event.result === 'pass' ? '✓' : event.result === 'skip' ? '−' : '✗'
              setMessages(prev => [...prev, {
                id: nextId(), role: 'system',
                content: `${icon} Gate ${event.gate}: ${event.result}`,
              }])
              break
            }

            case 'fix_iteration':
              setMessages(prev => [...prev, {
                id: nextId(), role: 'system',
                content: `↻ Fix iteration ${event.n}/${event.max}`,
              }])
              break

            case 'cr_detected':
              setMessages(prev => [...prev, {
                id: nextId(), role: 'system',
                content: `⚑ CR from ${event.cr.from}: ${event.cr.what}`,
              }])
              setPeerStatuses(prev => prev.map(p => ({...p, status: 'blocked', detail: 'consensus pause'})))
              break

            case 'complete':
              setOrchPhase('done')
              setPeerStatuses(prev => prev.map(p => ({...p, status: 'done', detail: 'session complete'})))
              setMessages(prev => [...prev, {
                id: nextId(), role: 'system',
                content: '✓ Session complete. See .orch/integration-report.md for details.',
              }])
              // Return to chat mode so user can ask follow-up questions
              setTimeout(() => setPhase('chat'), 500)
              break

            case 'error':
              setMessages(prev => [...prev, {
                id: nextId(), role: 'system',
                content: `Error: ${event.message}`,
              }])
              setPhase('chat')
              break
          }
        }
      } catch (err) {
        setMessages(prev => [...prev, {
          id: nextId(), role: 'system',
          content: `Orchestration error: ${err instanceof Error ? err.message : String(err)}`,
        }])
        setPhase('chat')
      }
    })()
  }, [repoRoot, orch, getPeerColorMap])

  // ── Slash commands ──
  const handleSlashCommand = useCallback((cmd: string): boolean => {
    const normalized = cmd.replace(/^\//, '').trim().toLowerCase()

    if (normalized === 'exit' || normalized === 'quit') {
      orchAbortRef.current = true
      onExit(); exit(); return true
    }
    if (normalized === 'help') {
      setMessages(prev => [...prev, {
        id: nextId(), role: 'system',
        content: [
          'Commands:',
          '  /run       — Start multi-agent coding session',
          '  /agents    — View/change agent models (✓ = connected)',
          '  /status    — Show phase, tasks, peer statuses',
          '  /conductor — Switch conductor model',
          '  /sessions  — List and resume past sessions',
          '  /compact   — Compress conversation context',
          '  /new       — Start fresh session',
          '  /help      — Show this help',
          '  /exit      — Quit',
        ].join('\n'),
      }])
      return true
    }
    if (normalized === 'run') {
      startOrchestration()
      return true
    }
    if (normalized === 'conductor') {
      setPhase('conductor_config')
      return true
    }
    if (normalized === 'new') {
      setPhase('select_conductor')
      setMessages([])
      setSessionId(null)
      return true
    }
    if (normalized === 'agents' || normalized === 'models') {
      setShowAgents(true)
      return true
    }
    if (normalized === 'sessions') {
      const sessions = listSessions(repoRoot)
      setSessionList(sessions.map(s => s.state))
      setShowSessions(true)
      return true
    }
    if (normalized === 'compact') {
      // Keep last 10 messages to save context
      setMessages(prev => {
        const keep = prev.slice(-10)
        const notice: MessageData = {id: nextId(), role: 'system', content: `Context compacted. ${prev.length - keep.length} messages removed.`}
        return [notice, ...keep]
      })
      return true
    }
    if (normalized === 'status') {
      const peers = orch.readPeers()
      const statuses = orch.allPeerStatuses()
      const plan = orch.readPlan()
      const lines = ['=== Status ===']
      if (peers) {
        lines.push(`Conductor: ${peers.conductor}`)
        for (const p of peers.peers) {
          const s = statuses.find(st => st.peer === p.id)
          lines.push(`${p.displayName}: contract v${s?.contractVersion ?? 0}, tasks: ${s?.activeTasks.join(',') || 'none'}`)
        }
      }
      if (plan) {
        const done = plan.tasks.filter(t => t.status === 'done').length
        lines.push(`Tasks: ${done}/${plan.tasks.length} done`)
      }
      setMessages(prev => [...prev, {id: nextId(), role: 'system', content: lines.join('\n')}])
      return true
    }
    return false
  }, [exit, onExit, startOrchestration, orch])

  const handleSubmit = useCallback(async (value: string) => {
    let trimmed = value.trim()
    if (!trimmed || !chat || loading) return

    // If submitting from slash menu, use the selected command
    if (trimmed.startsWith('/')) {
      const filter = trimmed.slice(1)
      const filtered = getFilteredCommands(filter)
      // If exactly one match or user hasn't fully typed it, auto-complete
      if (filtered.length === 1) {
        trimmed = filtered[0].name
      }
    }

    setInputValue('')
    setSlashIndex(0)

    if (trimmed.startsWith('/')) {
      if (handleSlashCommand(trimmed)) return
    }

    const userMsgId = nextId()
    const userMsg: MessageData = {id: userMsgId, role: 'user', content: trimmed}
    setMessages(prev => [...prev, userMsg])
    if (sessionId) {
      appendMessage(repoRoot, sessionId, userMsg)
      // Auto-title from first user message
      if (!titledRef.current) {
        titledRef.current = true
        updateSession(repoRoot, sessionId, {title: autoTitle(trimmed)})
      }
    }
    setLoading(true)

    const assistantMsgId = nextId()
    let assistantText = ''
    setMessages(prev => [...prev, {id: assistantMsgId, role: 'assistant', content: '', streaming: true}])

    try {
      for await (const event of chat.send(trimmed)) {
        if (event.type === 'text') {
          assistantText += event.content ?? ''
          setMessages(prev => prev.map(m => m.id === assistantMsgId ? {...m, content: assistantText} : m))
        } else if (event.type === 'tool_start') {
          setMessages(prev => [...prev, {id: nextId(), role: 'tool', content: `${event.toolName}...`, toolName: event.toolName}])
        } else if (event.type === 'tool_done') {
          setMessages(prev => {
            const idx = prev.findLastIndex(m => m.role === 'tool' && m.toolName === event.toolName)
            if (idx >= 0) {
              const updated = [...prev]
              updated[idx] = {...updated[idx], content: event.content ?? 'Done'}
              return updated
            }
            return prev
          })
          const name = orch.readProjectName()
          if (name) setProjectName(name)
        } else if (event.type === 'error') {
          setMessages(prev => [...prev, {id: nextId(), role: 'system', content: `Error: ${event.content}`}])
        } else if (event.type === 'done') {
          setMessages(prev => prev.map(m => m.id === assistantMsgId ? {...m, streaming: false} : m))
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, {id: nextId(), role: 'system', content: `Error: ${err instanceof Error ? err.message : String(err)}`}])
    }

    setLoading(false)
  }, [chat, loading, handleSlashCommand, orch])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      // Cancel current operation first, exit on second press
      if (loading && chat) {
        chat.abort()
        setLoading(false)
        setMessages(prev => {
          // End any streaming message
          const updated = prev.map(m => m.streaming ? {...m, streaming: false} : m)
          return [...updated, {id: nextId(), role: 'system' as const, content: 'Cancelled.'}]
        })
        return
      }
      if (phase === 'orchestrating') {
        orchAbortRef.current = true
        setMessages(prev => [...prev, {id: nextId(), role: 'system' as const, content: 'Orchestration cancelled.'}])
        setPhase('chat')
        return
      }
      onExit(); exit()
    }
    if (key.escape) {
      if (loading && chat) {
        chat.abort()
        setLoading(false)
        setMessages(prev => {
          const updated = prev.map(m => m.streaming ? {...m, streaming: false} : m)
          return [...updated, {id: nextId(), role: 'system' as const, content: 'Cancelled.'}]
        })
        return
      }
      if (phase === 'orchestrating') {
        orchAbortRef.current = true
        setMessages(prev => [...prev, {id: nextId(), role: 'system' as const, content: 'Orchestration cancelled.'}])
        setPhase('chat')
        return
      }
      if (phase === 'conductor_config') setPhase('chat')
      if (showAgents) setShowAgents(false)
      if (showSessions) setShowSessions(false)
    }
    // Slash menu navigation
    if (inputValue.startsWith('/') && !loading && phase === 'chat') {
      const filter = inputValue.slice(1)
      const filtered = getFilteredCommands(filter)
      if (key.upArrow) {
        setSlashIndex(prev => Math.max(0, prev - 1))
      } else if (key.downArrow) {
        setSlashIndex(prev => Math.min(filtered.length - 1, prev + 1))
      } else if (key.tab) {
        // Tab-complete the selected command
        if (filtered[slashIndex]) {
          setInputValue(filtered[slashIndex].name)
          setSlashIndex(0)
        }
      }
    }
  })

  // Model fetching is handled inside ConductorManager and AgentManager components

  // ── Render ──

  if (phase === 'select_conductor') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>{'─'.repeat(60)}</Text>
          <Box>
            <Text bold color="cyanBright">  MetaCLiDE</Text>
            <Text dimColor>  Multi-Agent Orchestration</Text>
          </Box>
          <Text dimColor>{'─'.repeat(60)}</Text>
        </Box>
        <ConductorSelect onSelect={handleConductorSelect} />
        {messages.length > 0 && (
          <Box marginTop={1}>
            <Text color="red">{messages[messages.length - 1].content}</Text>
          </Box>
        )}
      </Box>
    )
  }

  if (phase === 'enter_key') {
    const cfg = PROVIDER_ENV[conductor?.provider ?? 'anthropic']
    return (
      <Box flexDirection="column" padding={1}>
        <Header conductorName={conductor?.displayName ?? ''} projectName={projectName} phase="" model={chat?.getModel()} />
        <ApiKeyInput envVar={cfg.envVar} onSubmit={handleApiKey} />
      </Box>
    )
  }

  if (phase === 'oauth_login') {
    return (
      <Box flexDirection="column" padding={1}>
        <Header conductorName={conductor?.displayName ?? ''} projectName={projectName} phase="" />
        <Box flexDirection="column">
          <Text bold>Logging in to {conductor?.displayName ?? 'provider'}...</Text>
          <Box marginTop={1}>
            <Text color="yellow">● </Text>
            <Text>{oauthStatus}</Text>
          </Box>
        </Box>
      </Box>
    )
  }

  if (phase === 'conductor_config') {
    return (
      <Box flexDirection="column" padding={1}>
        <Header conductorName={conductor?.displayName ?? ''} projectName={projectName} phase="" model={chat?.getModel()} />
        <ConductorManager
          currentProvider={conductor?.provider ?? ''}
          currentModel={chat?.getModel()}
          onSelect={async (selection: ConductorSelection) => {
            const {choice, model, resolvedApiKey} = selection

            // Resolve the actual API key (from keychain/env if not already provided)
            let apiKey: string | undefined = resolvedApiKey
            if (choice.mode === 'byok' && !apiKey) {
              const cfg = PROVIDER_ENV[choice.provider]
              if (cfg) {
                const envKey = process.env[cfg.envVar]?.trim()
                if (envKey) {
                  apiKey = envKey
                } else {
                  const stored = await getCredential(cfg.keychainId)
                  apiKey = stored?.trim() || undefined
                }
              }
            }

            // If BYOK and still no key, prompt for it
            if (choice.mode === 'byok' && !apiKey) {
              setConductor(choice)
              setPhase('enter_key')
              return
            }

            // Create new conductor chat with chosen provider + model
            const newChat = new ConductorChat({
              provider: choice.provider,
              mode: choice.mode,
              apiKey,
              repoRoot,
              orch,
            })
            newChat.setModel(model)
            setConductor(choice)
            setChat(newChat)
            setPhase('chat')
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `Conductor → ${choice.displayName}  model: ${model}`,
            }])
          }}
          onBack={() => setPhase('chat')}
        />
      </Box>
    )
  }

  // ── Agent manager overlay ──
  if (showAgents) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header conductorName={conductor?.displayName ?? ''} projectName={projectName} phase="" />
        <AgentManager
          agents={buildAgentEntries()}
          onModelChange={(agentId, model) => {
            // Auto-add agent to peers.json if not configured yet
            let peersFile = orch.readPeers()
            if (!peersFile) {
              // Create peers.json with conductor from current session
              peersFile = {conductor: conductor?.displayName?.toLowerCase() ?? 'claude', peers: []}
            }
            const existing = peersFile.peers.find(p => p.id === agentId)
            if (!existing) {
              const builtIn = BUILT_IN_AGENTS.find(a => a.id === agentId)
              peersFile.peers.push({
                id: agentId,
                displayName: builtIn?.displayName ?? agentId,
                type: 'tool',
                provider: (builtIn?.provider ?? agentId) as 'anthropic' | 'openai' | 'moonshot',
                mode: builtIn?.defaultMode === 'oauth' ? 'oauth' : 'byok',
                model,
                contextFile: builtIn?.contextFile ?? 'AGENTS.md',
                branch: `agent/${agentId}`,
                role: 'implementer',
              })
              orch.writePeers(peersFile)
            } else {
              orch.updatePeerModel(agentId, model)
            }
            setMessages(prev => [...prev, {
              id: nextId(), role: 'system',
              content: `✓ ${agentId} configured → ${model}`,
            }])
          }}
          onBack={() => setShowAgents(false)}
        />
      </Box>
    )
  }

  // ── Session picker overlay ──
  if (showSessions) {
    const items = sessionList.length > 0
      ? sessionList.map(s => ({
          key: s.id,
          label: `${s.title} (${s.conductorDisplayName}, ${new Date(s.updatedAt).toLocaleDateString()})`,
          value: s.id,
        }))
      : [{key: 'empty', label: 'No sessions found', value: ''}]

    return (
      <Box flexDirection="column" padding={1}>
        <Header conductorName={conductor?.displayName ?? ''} projectName={projectName} phase="" />
        <Text bold>Resume a session:</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[...items, {key: 'back', label: '← Back', value: '__back__'}]}
            onSelect={item => {
              if (item.value === '__back__' || !item.value) {
                setShowSessions(false)
                return
              }
              setShowSessions(false)
              // Resume selected session
              const selected = sessionList.find(s => s.id === item.value)
              if (selected) {
                const choice: ConductorChoice = {
                  provider: selected.conductorProvider as 'anthropic' | 'openai' | 'moonshot',
                  mode: selected.conductorMode as 'byok' | 'oauth',
                  displayName: selected.conductorDisplayName,
                }
                const cfg = PROVIDER_ENV[selected.conductorProvider]
                if (cfg) {
                  getCredential(cfg.keychainId).then(key => {
                    startChat(choice, key ?? undefined, item.value)
                  }).catch(() => {
                    startChat(choice, undefined, item.value)
                  })
                }
              }
            }}
          />
        </Box>
      </Box>
    )
  }

  // Orchestrating + chat phases share the same layout
  const isOrchestrating = phase === 'orchestrating'

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        conductorName={conductor?.displayName ?? ''}
        projectName={projectName}
        phase={isOrchestrating ? orchPhase : ''}
        model={!isOrchestrating ? chat?.getModel() : undefined}
        contractVersion={isOrchestrating ? orch.readContractVersion() : undefined}
        peerCount={isOrchestrating ? peerStatuses.length : undefined}
      />
      {isOrchestrating && peerStatuses.length > 0 && (
        <PeerStatusPanel peers={peerStatuses} phase={orchPhase} />
      )}
      <ChatHistory messages={messages} />
      {!loading && !isOrchestrating && inputValue.startsWith('/') && (
        <SlashMenu filter={inputValue.slice(1)} selectedIndex={slashIndex} />
      )}
      {!loading && !isOrchestrating && (
        <Box>
          <Text bold color="cyanBright">❯ </Text>
          <TextInput value={inputValue} onChange={(v) => { setInputValue(v); if (v.startsWith('/')) setSlashIndex(0) }} onSubmit={handleSubmit} />
        </Box>
      )}
      {isOrchestrating && (
        <Box marginTop={0}>
          <Text dimColor>Agents working  ·  Ctrl+C to abort</Text>
        </Box>
      )}
      {!isOrchestrating && (
        <StatusBar
          loading={loading}
          hint={sessionId ? `session:${sessionId.slice(0, 8)}  /help for commands` : undefined}
        />
      )}
    </Box>
  )
}
