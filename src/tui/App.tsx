import React, {useState, useCallback} from 'react'
import {Box, Text, useApp, useInput} from 'ink'
import TextInput from 'ink-text-input'
import {Header} from './Header.js'
import {ChatHistory} from './ChatHistory.js'
import {StatusBar} from './StatusBar.js'
import {ConductorSelect, type ConductorChoice} from './ConductorSelect.js'
import {ApiKeyInput} from './ApiKeyInput.js'
import {ConductorChat, AVAILABLE_MODELS} from './conductor.js'
import {OrchManager} from '../lib/orch/index.js'
import {getCredential, storeCredential} from '../lib/auth/keychain.js'
import {getCodexApiKey, loginCodexBrowser, loginCodexDevice} from '../lib/auth/oauth-codex.js'
import {getKimiAccessToken, loginKimiDevice} from '../lib/auth/oauth-kimi.js'
import type {MessageData} from './Message.js'

type Phase = 'select_conductor' | 'enter_key' | 'oauth_login' | 'chat' | 'model_select'

const PROVIDER_ENV: Record<string, {envVar: string; keychainId: string}> = {
  anthropic: {envVar: 'ANTHROPIC_API_KEY', keychainId: 'anthropic'},
  openai: {envVar: 'OPENAI_API_KEY', keychainId: 'openai'},
  moonshot: {envVar: 'MOONSHOT_API_KEY', keychainId: 'moonshot'},
}

interface AppProps {
  repoRoot: string
  orch: OrchManager
  onExit: () => void
}

let msgCounter = 0
function nextId() { return `msg-${++msgCounter}` }

export function App({repoRoot, orch, onExit}: AppProps) {
  const {exit} = useApp()
  const [phase, setPhase] = useState<Phase>('select_conductor')
  const [conductor, setConductor] = useState<ConductorChoice | null>(null)
  const [chat, setChat] = useState<ConductorChat | null>(null)
  const [messages, setMessages] = useState<MessageData[]>([])
  const [inputValue, setInputValue] = useState('')
  const [loading, setLoading] = useState(false)
  const [projectName, setProjectName] = useState(() => orch.readProjectName() || '')
  const [oauthStatus, setOauthStatus] = useState('')

  // Try to auto-resolve API key
  const resolveKey = useCallback(async (provider: string): Promise<string | null> => {
    const cfg = PROVIDER_ENV[provider]
    if (!cfg) return null
    const envKey = process.env[cfg.envVar]?.trim()
    if (envKey) return envKey
    const stored = await getCredential(cfg.keychainId)
    if (stored?.trim()) return stored.trim()
    return null
  }, [])

  const startChat = useCallback((choice: ConductorChoice, apiKey?: string) => {
    const c = new ConductorChat({
      provider: choice.provider,
      mode: choice.mode,
      apiKey,
      repoRoot,
      orch,
    })
    setConductor(choice)
    setChat(c)
    setPhase('chat')

    const brief = orch.readBrief()
    const hasContent = brief && !brief.includes('<!-- Brief will be written')
    setMessages([{
      id: nextId(),
      role: 'system',
      content: hasContent
        ? 'Project brief loaded. Type your message or /help for commands.'
        : 'Tell me about your project — what do you want to build?',
    }])
  }, [repoRoot, orch])

  const handleConductorSelect = useCallback(async (choice: ConductorChoice) => {
    if (choice.mode === 'oauth') {
      // Check for existing session first
      if (choice.provider === 'openai') {
        const existingKey = getCodexApiKey()
        if (existingKey) {
          startChat(choice, existingKey)
          return
        }
      } else if (choice.provider === 'moonshot') {
        const existingToken = getKimiAccessToken()
        if (existingToken) {
          startChat(choice, existingToken)
          return
        }
      }

      // No existing session — trigger OAuth login
      setConductor(choice)
      setPhase('oauth_login')
      setOauthStatus('Starting login...')

      try {
        let apiKey: string

        if (choice.provider === 'openai') {
          // Try browser flow first, fall back to device code
          try {
            apiKey = await loginCodexBrowser((event) => {
              setOauthStatus(event.message)
            })
          } catch {
            // Browser flow failed (port in use, etc.) — try device code
            setOauthStatus('Browser flow unavailable, using device code...')
            apiKey = await loginCodexDevice((event) => {
              setOauthStatus(event.message)
            })
          }
        } else {
          // Kimi — device code only
          apiKey = await loginKimiDevice((event) => {
            setOauthStatus(event.message)
          })
        }

        startChat(choice, apiKey)
      } catch (err) {
        setOauthStatus('')
        setPhase('select_conductor')
        setMessages([{
          id: nextId(),
          role: 'system',
          content: `OAuth login failed: ${err instanceof Error ? err.message : String(err)}`,
        }])
      }
      return
    }

    // BYOK — try auto-resolve
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

  const handleSlashCommand = useCallback((cmd: string): boolean => {
    const normalized = cmd.replace(/^\//, '').trim()
    if (normalized === 'exit' || normalized === 'quit') {
      onExit()
      exit()
      return true
    }
    if (normalized === 'help') {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        content: 'Commands: /run  /status  /logs  /help  /exit\nEverything else is sent to the Conductor.',
      }])
      return true
    }
    if (normalized === 'status' || normalized === 'run' || normalized === 'logs') {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        content: `Use \`metaclide ${normalized}\` from the terminal for now.`,
      }])
      return true
    }
    return false
  }, [exit, onExit])

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || !chat || loading) return

    setInputValue('')

    if (trimmed.startsWith('/')) {
      if (handleSlashCommand(trimmed)) return
    }

    const userMsgId = nextId()
    setMessages(prev => [...prev, {id: userMsgId, role: 'user', content: trimmed}])
    setLoading(true)

    const assistantMsgId = nextId()
    let assistantText = ''

    setMessages(prev => [...prev, {id: assistantMsgId, role: 'assistant', content: '', streaming: true}])

    try {
      for await (const event of chat.send(trimmed)) {
        if (event.type === 'text') {
          assistantText += event.content ?? ''
          setMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? {...m, content: assistantText} : m
          ))
        } else if (event.type === 'tool_start') {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'tool',
            content: `${event.toolName}...`,
            toolName: event.toolName,
          }])
        } else if (event.type === 'tool_done') {
          setMessages(prev => {
            const idx = prev.findLastIndex((m: MessageData) => m.role === 'tool' && m.toolName === event.toolName)
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
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `Error: ${event.content}`,
          }])
        } else if (event.type === 'done') {
          setMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? {...m, streaming: false} : m
          ))
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }])
    }

    setLoading(false)
  }, [chat, loading, handleSlashCommand, orch])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onExit()
      exit()
    }
  })

  // ── Render phases ──

  if (phase === 'select_conductor') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">MetaCLiDE</Text>
          <Text dimColor> — Multi-Agent Coding Orchestration</Text>
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
        <Box marginBottom={1}>
          <Text bold color="cyan">MetaCLiDE</Text>
          <Text dimColor> — Multi-Agent Coding Orchestration</Text>
        </Box>
        <ApiKeyInput envVar={cfg.envVar} onSubmit={handleApiKey} />
      </Box>
    )
  }

  if (phase === 'oauth_login') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">MetaCLiDE</Text>
          <Text dimColor> — Multi-Agent Coding Orchestration</Text>
        </Box>
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

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        conductorName={conductor?.displayName ?? ''}
        projectName={projectName}
        phase=""
      />
      <ChatHistory messages={messages} />
      {!loading && (
        <Box>
          <Text bold color="blue">you&gt; </Text>
          <TextInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmit}
          />
        </Box>
      )}
      <StatusBar loading={loading} />
    </Box>
  )
}
