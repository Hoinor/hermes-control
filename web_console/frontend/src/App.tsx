import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

type TabKey = 'dashboard' | 'services' | 'models' | 'logs' | 'chat'

type ProviderView = {
  key: string
  name: string
  api: string
  api_key: string
  default_model: string
  models: string[]
}

type ActiveModel = {
  provider: string
  base_url: string
  api_key: string
  default: string
}

type ConfigView = {
  raw: Record<string, unknown>
  providers: ProviderView[]
  active_model: ActiveModel
}

type ConfigResponse = {
  ok: boolean
  raw_yaml: string
  view: ConfigView
}

type AuthStatusResponse = {
  setup_required: boolean
  authenticated: boolean
}

type DashboardResponse = {
  hermes: {
    installed: boolean
    version: string
    bin_path: string
    gateway_installed: boolean
    gateway_status: {
      running: boolean
      source: string
    }
  }
  system: {
    platform: string
    hostname: string
    cpu_percent: number
    memory_used: number
    memory_total: number
    disk_used: number
    disk_total: number
    uptime_seconds: number
  }
}

type BackupItem = {
  name: string
  mtime: number
}

type LogSource = {
  id: string
  name: string
}

type ModelTestResult = {
  provider_key: string
  model: string
  ok: boolean
  latency_ms: number | null
  status_code: number
  error: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

class ApiError extends Error {
  status: number

  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.headers) {
    const incoming = new Headers(init.headers)
    incoming.forEach((value, key) => {
      headers[key] = value
    })
  }

  let body = init.body
  if (body && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }

  const response = await fetch(path, {
    ...init,
    headers,
    body,
    credentials: 'same-origin',
  })

  const raw = await response.text()
  let parsed: unknown = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = { detail: raw }
  }

  if (!response.ok) {
    const detail =
      typeof parsed === 'object' && parsed && 'detail' in parsed
        ? String((parsed as { detail: unknown }).detail)
        : `HTTP ${response.status}`
    throw new ApiError(response.status, detail)
  }

  return parsed as T
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '--'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let value = bytes
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--'
  const day = Math.floor(seconds / 86400)
  const hour = Math.floor((seconds % 86400) / 3600)
  const minute = Math.floor((seconds % 3600) / 60)
  return `${day}d ${hour}h ${minute}m`
}

function normalizeProviderKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function App() {
  const { t, i18n } = useTranslation()

  const [activeTab, setActiveTab] = useState<TabKey>('dashboard')

  const [authChecking, setAuthChecking] = useState(true)
  const [setupRequired, setSetupRequired] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')

  const [dashboardData, setDashboardData] = useState<DashboardResponse | null>(null)
  const [saveState, setSaveState] = useState<string>(t('status.saveIdle'))

  const [quickActionOutput, setQuickActionOutput] = useState('')
  const [serviceOutput, setServiceOutput] = useState('')

  const [configRaw, setConfigRaw] = useState<Record<string, unknown>>({})
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0)
  const [activeModel, setActiveModel] = useState<ActiveModel>({
    provider: '',
    base_url: '',
    api_key: '',
    default: '',
  })
  const [rawYaml, setRawYaml] = useState('')

  const [backups, setBackups] = useState<BackupItem[]>([])
  const [selectedBackup, setSelectedBackup] = useState('')
  const [backupOutput, setBackupOutput] = useState('')

  const [logSources, setLogSources] = useState<LogSource[]>([])
  const [selectedLogSource, setSelectedLogSource] = useState('')
  const [logKeyword, setLogKeyword] = useState('')
  const [logAutoRefresh, setLogAutoRefresh] = useState(true)
  const [logOutput, setLogOutput] = useState('')

  const [testResults, setTestResults] = useState<ModelTestResult[]>([])

  const [chatProvider, setChatProvider] = useState('')
  const [chatModelOverride, setChatModelOverride] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])

  const dashboardTimerRef = useRef<number | null>(null)
  const logTimerRef = useRef<number | null>(null)
  const saveTimerRef = useRef<number | null>(null)

  const selectedProvider = providers[selectedProviderIndex] ?? null

  const hermesStatusText = useMemo(() => {
    if (!dashboardData?.hermes.installed) return t('status.hermesMissing')
    return t('status.hermesInstalled', {
      version: dashboardData.hermes.version || 'installed',
    })
  }, [dashboardData, t])

  const gatewayStatusText = useMemo(() => {
    return t('status.gateway', {
      status: dashboardData?.hermes.gateway_status.running
        ? t('common.running')
        : t('common.stopped'),
    })
  }, [dashboardData, t])

  const stopTimers = () => {
    if (dashboardTimerRef.current) {
      window.clearInterval(dashboardTimerRef.current)
      dashboardTimerRef.current = null
    }
    if (logTimerRef.current) {
      window.clearInterval(logTimerRef.current)
      logTimerRef.current = null
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }

  const handleUnauthorized = (error: unknown) => {
    if (error instanceof ApiError && (error.status === 401 || error.status === 428)) {
      setAuthenticated(false)
      stopTimers()
      void checkAuthState()
      return true
    }
    return false
  }

  const refreshDashboard = async () => {
    try {
      const data = await apiRequest<DashboardResponse>('/api/dashboard/state')
      setDashboardData(data)
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setQuickActionOutput(String((error as Error).message || error))
      }
    }
  }

  const loadConfig = async () => {
    try {
      const data = await apiRequest<ConfigResponse>('/api/config')
      setConfigRaw(data.view.raw || {})
      setProviders(data.view.providers || [])
      setActiveModel(
        data.view.active_model || {
          provider: '',
          base_url: '',
          api_key: '',
          default: '',
        },
      )
      setRawYaml(data.raw_yaml || '')
      setSelectedProviderIndex(0)
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setServiceOutput(String((error as Error).message || error))
      }
    }
  }

  const loadBackups = async () => {
    try {
      const data = await apiRequest<{ backups: BackupItem[] }>('/api/config/backups')
      const nextBackups = data.backups || []
      setBackups(nextBackups)
      if (nextBackups.length > 0) {
        setSelectedBackup(nextBackups[0].name)
      } else {
        setSelectedBackup('')
      }
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setBackupOutput(String((error as Error).message || error))
      }
    }
  }

  const loadLogSources = async () => {
    try {
      const data = await apiRequest<{ sources: LogSource[] }>('/api/logs/sources')
      const nextSources = data.sources || []
      setLogSources(nextSources)
      if (nextSources.length > 0) {
        setSelectedLogSource((current) => current || nextSources[0].id)
      } else {
        setSelectedLogSource('')
      }
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setLogOutput(String((error as Error).message || error))
      }
    }
  }

  const refreshLogs = async () => {
    if (!selectedLogSource) return
    try {
      const data = await apiRequest<{ text: string }>(
        `/api/logs/read?source=${encodeURIComponent(selectedLogSource)}&q=${encodeURIComponent(logKeyword)}&limit=400`,
      )
      setLogOutput(data.text || '')
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setLogOutput(String((error as Error).message || error))
      }
    }
  }

  const enterApp = async () => {
    setAuthenticated(true)
    setAuthError('')
    await Promise.all([refreshDashboard(), loadConfig(), loadBackups(), loadLogSources()])

    if (dashboardTimerRef.current) window.clearInterval(dashboardTimerRef.current)
    dashboardTimerRef.current = window.setInterval(() => {
      void refreshDashboard()
    }, 5000)
  }

  const checkAuthState = async () => {
    setAuthChecking(true)
    try {
      const status = await apiRequest<AuthStatusResponse>('/api/auth/status')
      setSetupRequired(status.setup_required)
      if (status.authenticated) {
        await enterApp()
      } else {
        setAuthenticated(false)
        stopTimers()
      }
    } catch (error) {
      setAuthenticated(false)
      stopTimers()
      setAuthError(String((error as Error).message || error))
    } finally {
      setAuthChecking(false)
    }
  }

  const buildSyncedConfig = () => {
    const nextConfig: Record<string, unknown> = { ...configRaw }

    const providersMap: Record<string, unknown> = {}
    providers.forEach((provider) => {
      const key = normalizeProviderKey(provider.key)
      if (!key) return
      providersMap[key] = {
        name: provider.name || key,
        api: provider.api || '',
        api_key: provider.api_key || '',
        default_model: provider.default_model || '',
        models: (provider.models || []).map((item) => item.trim()).filter(Boolean),
      }
    })

    nextConfig.providers = providersMap
    nextConfig.model = {
      provider: activeModel.provider,
      base_url: activeModel.base_url,
      api_key: activeModel.api_key,
      default: activeModel.default,
    }

    return nextConfig
  }

  const saveConfigNow = async () => {
    try {
      const synced = buildSyncedConfig()
      await apiRequest('/api/config/save', {
        method: 'POST',
        body: JSON.stringify({ config: synced }),
        headers: { 'Content-Type': 'application/json' },
      })
      setConfigRaw(synced)
      setSaveState(t('status.saveSuccess', { time: new Date().toLocaleTimeString() }))
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setSaveState(
          t('status.saveFailed', {
            message: String((error as Error).message || error),
          }),
        )
      }
    }
  }

  const scheduleAutoSave = () => {
    setSaveState(t('status.savePending'))
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      void saveConfigNow()
    }, 850)
  }

  const runServiceAction = async (
    action: string,
    setOutput: (value: string) => void,
    label: string,
  ) => {
    setOutput(t('actions.running', { action: label }))
    try {
      const result = await apiRequest('/api/service/action', {
        method: 'POST',
        body: JSON.stringify({ action }),
        headers: { 'Content-Type': 'application/json' },
      })
      setOutput(JSON.stringify(result, null, 2))
      await refreshDashboard()
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setOutput(
          t('actions.error', {
            message: String((error as Error).message || error),
          }),
        )
      }
    }
  }

  const saveRawYaml = async () => {
    try {
      await apiRequest('/api/config/raw', {
        method: 'POST',
        body: JSON.stringify({ raw_yaml: rawYaml }),
        headers: { 'Content-Type': 'application/json' },
      })
      await loadConfig()
      setSaveState(t('status.saveSuccess', { time: new Date().toLocaleTimeString() }))
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setSaveState(
          t('status.saveFailed', {
            message: String((error as Error).message || error),
          }),
        )
      }
    }
  }

  const testAllModels = async () => {
    setTestResults([])
    setServiceOutput(t('models.testAllLoading'))
    try {
      const result = await apiRequest<{ results: ModelTestResult[] }>('/api/models/test', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      })
      setTestResults(result.results || [])
      setServiceOutput('')
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setServiceOutput(String((error as Error).message || error))
      }
    }
  }

  const testCurrentProvider = async () => {
    if (!selectedProvider) return
    const models =
      selectedProvider.models?.length > 0
        ? selectedProvider.models
        : selectedProvider.default_model
          ? [selectedProvider.default_model]
          : []
    if (models.length === 0) return

    setTestResults([])
    setServiceOutput(t('models.testProviderLoading'))

    try {
      const payload = {
        targets: models.map((model) => ({
          provider_key: selectedProvider.key,
          model,
          api_base_url: selectedProvider.api,
          api_key: selectedProvider.api_key,
        })),
      }
      const result = await apiRequest<{ results: ModelTestResult[] }>('/api/models/test', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      })
      setTestResults(result.results || [])
      setServiceOutput('')
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setServiceOutput(String((error as Error).message || error))
      }
    }
  }

  useEffect(() => {
    void checkAuthState()
    return () => stopTimers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (logTimerRef.current) {
      window.clearInterval(logTimerRef.current)
      logTimerRef.current = null
    }
    if (!authenticated || !logAutoRefresh) return
    logTimerRef.current = window.setInterval(() => {
      void refreshLogs()
    }, 3000)
    return () => {
      if (logTimerRef.current) {
        window.clearInterval(logTimerRef.current)
        logTimerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, logAutoRefresh, selectedLogSource, logKeyword])

  useEffect(() => {
    if (authenticated && activeTab === 'logs') {
      void refreshLogs()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedLogSource])

  useEffect(() => {
    setSaveState(t('status.saveIdle'))
  }, [t])

  const navItems: Array<{ key: TabKey; label: string; icon: string }> = [
    { key: 'dashboard', label: t('nav.dashboard'), icon: '◈' },
    { key: 'services', label: t('nav.services'), icon: '⚙' },
    { key: 'models', label: t('nav.modelConfig'), icon: '⬢' },
    { key: 'logs', label: t('nav.logs'), icon: '☰' },
    { key: 'chat', label: t('nav.chat'), icon: '✦' },
  ]

  const onSetupSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setAuthError('')
    try {
      await apiRequest('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: authPassword }),
        headers: { 'Content-Type': 'application/json' },
      })
      setAuthPassword('')
      await enterApp()
    } catch (error) {
      setAuthError(String((error as Error).message || error))
    }
  }

  const onLoginSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setAuthError('')
    try {
      await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: authPassword }),
        headers: { 'Content-Type': 'application/json' },
      })
      setAuthPassword('')
      await enterApp()
    } catch (error) {
      setAuthError(String((error as Error).message || error))
    }
  }

  const onLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
    } catch {
      // ignore
    }
    setAuthenticated(false)
    stopTimers()
    void checkAuthState()
  }

  const onCreateBackup = async () => {
    try {
      const result = await apiRequest('/api/config/backup', { method: 'POST' })
      setBackupOutput(JSON.stringify(result, null, 2))
      await loadBackups()
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setBackupOutput(String((error as Error).message || error))
      }
    }
  }

  const onRestoreBackup = async () => {
    if (!selectedBackup) return
    if (!window.confirm(`Restore backup ${selectedBackup}?`)) return
    try {
      const result = await apiRequest('/api/config/restore', {
        method: 'POST',
        body: JSON.stringify({ backup_name: selectedBackup }),
        headers: { 'Content-Type': 'application/json' },
      })
      setBackupOutput(JSON.stringify(result, null, 2))
      await loadConfig()
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setBackupOutput(String((error as Error).message || error))
      }
    }
  }

  const onAddProvider = () => {
    const input = window.prompt(t('models.providerKeyPlaceholder'))
    if (!input) return
    const key = normalizeProviderKey(input)
    if (!key) return
    if (providers.some((provider) => provider.key === key)) {
      window.alert(t('models.providerExists'))
      return
    }
    setProviders((prev) => [
      ...prev,
      {
        key,
        name: key,
        api: '',
        api_key: '',
        default_model: '',
        models: [],
      },
    ])
    setSelectedProviderIndex(providers.length)
    scheduleAutoSave()
  }

  const onDeleteProvider = () => {
    if (!selectedProvider) return
    if (!window.confirm(t('models.confirmDeleteProvider', { key: selectedProvider.key }))) return
    setProviders((prev) => prev.filter((_, index) => index !== selectedProviderIndex))
    setSelectedProviderIndex((prev) => Math.max(0, prev - 1))
    scheduleAutoSave()
  }

  const onAddModel = () => {
    if (!selectedProvider) return
    const model = window.prompt(t('models.newModelPlaceholder'))
    if (!model?.trim()) return
    const nextProviders = [...providers]
    const nextModels = [...(nextProviders[selectedProviderIndex].models || []), model.trim()]
    nextProviders[selectedProviderIndex] = {
      ...nextProviders[selectedProviderIndex],
      models: nextModels,
    }
    setProviders(nextProviders)
    scheduleAutoSave()
  }

  const onSendChat = async (event: FormEvent) => {
    event.preventDefault()
    const prompt = chatInput.trim()
    if (!prompt) return

    const history = chatMessages.slice(-10)
    const nextMessages = [...chatMessages, { role: 'user', content: prompt } as ChatMessage]
    setChatMessages([...nextMessages, { role: 'assistant', content: '...' }])
    setChatInput('')

    const payload = {
      messages: [...history, { role: 'user', content: prompt }],
      provider_key: chatProvider || null,
      model: chatModelOverride.trim() || null,
      temperature: 0.2,
    }

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text)
      }
      if (!response.body) {
        throw new Error('empty response body')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let finalText = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        finalText += decoder.decode(value, { stream: true })
        setChatMessages((prev) => {
          if (prev.length === 0) return prev
          const copy = [...prev]
          copy[copy.length - 1] = { role: 'assistant', content: finalText }
          return copy
        })
      }
    } catch (error) {
      setChatMessages((prev) => {
        if (prev.length === 0) return prev
        const copy = [...prev]
        copy[copy.length - 1] = {
          role: 'assistant',
          content: t('actions.error', { message: String((error as Error).message || error) }),
        }
        return copy
      })
    }
  }

  const actionLabel = (action: string) => {
    switch (action) {
      case 'gateway_start':
        return t('dashboard.startGateway')
      case 'gateway_stop':
        return t('dashboard.stopGateway')
      case 'gateway_restart':
        return t('dashboard.restartGateway')
      case 'upgrade':
        return t('dashboard.oneClickUpgrade')
      case 'version_check':
        return t('services.versionCheck')
      case 'gateway_install':
        return t('services.installGateway')
      case 'gateway_uninstall':
        return t('services.uninstallGateway')
      default:
        return action
    }
  }

  const authHint = authChecking
    ? t('auth.loading')
    : setupRequired
      ? t('auth.firstLaunch')
      : t('auth.authRequired')

  if (!authenticated) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>{t('app.title')}</h1>
          <p>{authHint}</p>

          {setupRequired ? (
            <form onSubmit={onSetupSubmit} className="auth-form">
              <label>{t('auth.createPassword')}</label>
              <input
                type="password"
                minLength={8}
                required
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
              />
              <button type="submit">{t('auth.initializeEnter')}</button>
            </form>
          ) : (
            <form onSubmit={onLoginSubmit} className="auth-form">
              <label>{t('auth.password')}</label>
              <input
                type="password"
                minLength={8}
                required
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
              />
              <button type="submit">{t('auth.login')}</button>
            </form>
          )}

          {authError && <p className="error">{authError}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="console-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-title">{t('app.title')}</div>
            <div className="brand-subtitle">Gateway Admin</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${activeTab === item.key ? 'active' : ''}`}
              onClick={() => setActiveTab(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="main-shell">
        <header className="top-header">
          <div className="status-row">
            <span className="chip">{hermesStatusText}</span>
            <span className="chip">{gatewayStatusText}</span>
            <span className="chip muted">{saveState}</span>
          </div>

          <div className="header-actions">
            <span className="port-label">{t('header.port')}</span>
            <label className="language-switch">
              <span>{t('header.language')}</span>
              <select
                value={i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US'}
                onChange={(event) => {
                  void i18n.changeLanguage(event.target.value)
                }}
              >
                <option value="en-US">English</option>
                <option value="zh-CN">中文</option>
              </select>
            </label>
            <button className="danger" onClick={onLogout}>
              {t('auth.logout')}
            </button>
          </div>
        </header>

        <main className="content-area">
          {activeTab === 'dashboard' && (
            <section className="card-grid three">
              <article className="card">
                <h3>{t('dashboard.systemSnapshot')}</h3>
                <ul className="metric-list">
                  <li>
                    <span>{t('dashboard.os')}</span>
                    <strong>{dashboardData?.system.platform || t('common.unknown')}</strong>
                  </li>
                  <li>
                    <span>{t('dashboard.host')}</span>
                    <strong>{dashboardData?.system.hostname || t('common.unknown')}</strong>
                  </li>
                  <li>
                    <span>{t('dashboard.cpu')}</span>
                    <strong>{(dashboardData?.system.cpu_percent || 0).toFixed(1)}%</strong>
                  </li>
                  <li>
                    <span>{t('dashboard.memory')}</span>
                    <strong>
                      {formatBytes(dashboardData?.system.memory_used || 0)} /{' '}
                      {formatBytes(dashboardData?.system.memory_total || 0)}
                    </strong>
                  </li>
                  <li>
                    <span>{t('dashboard.disk')}</span>
                    <strong>
                      {formatBytes(dashboardData?.system.disk_used || 0)} /{' '}
                      {formatBytes(dashboardData?.system.disk_total || 0)}
                    </strong>
                  </li>
                  <li>
                    <span>{t('dashboard.uptime')}</span>
                    <strong>{formatUptime(dashboardData?.system.uptime_seconds || 0)}</strong>
                  </li>
                </ul>
              </article>

              <article className="card">
                <h3>{t('dashboard.hermesSnapshot')}</h3>
                <ul className="metric-list">
                  <li>
                    <span>{t('dashboard.installed')}</span>
                    <strong>
                      {dashboardData?.hermes.installed ? t('common.yes') : t('common.no')}
                    </strong>
                  </li>
                  <li>
                    <span>{t('dashboard.version')}</span>
                    <strong>{dashboardData?.hermes.version || t('common.unknown')}</strong>
                  </li>
                  <li>
                    <span>{t('dashboard.binary')}</span>
                    <strong>{dashboardData?.hermes.bin_path || t('common.unknown')}</strong>
                  </li>
                  <li>
                    <span>{t('dashboard.gatewayInstalled')}</span>
                    <strong>
                      {dashboardData?.hermes.gateway_installed ? t('common.yes') : t('common.no')}
                    </strong>
                  </li>
                  <li>
                    <span>{t('dashboard.gatewayRuntime')}</span>
                    <strong>
                      {dashboardData?.hermes.gateway_status.running
                        ? t('common.running')
                        : t('common.stopped')}
                    </strong>
                  </li>
                  <li>
                    <span>{t('dashboard.statusSource')}</span>
                    <strong>{dashboardData?.hermes.gateway_status.source || t('common.unknown')}</strong>
                  </li>
                </ul>
              </article>

              <article className="card">
                <h3>{t('dashboard.quickActions')}</h3>
                <div className="button-wrap">
                  <button
                    onClick={() =>
                      void runServiceAction(
                        'gateway_start',
                        setQuickActionOutput,
                        actionLabel('gateway_start'),
                      )
                    }
                  >
                    {t('dashboard.startGateway')}
                  </button>
                  <button
                    onClick={() =>
                      void runServiceAction(
                        'gateway_stop',
                        setQuickActionOutput,
                        actionLabel('gateway_stop'),
                      )
                    }
                  >
                    {t('dashboard.stopGateway')}
                  </button>
                  <button
                    onClick={() =>
                      void runServiceAction(
                        'gateway_restart',
                        setQuickActionOutput,
                        actionLabel('gateway_restart'),
                      )
                    }
                  >
                    {t('dashboard.restartGateway')}
                  </button>
                  <button
                    onClick={() =>
                      void runServiceAction(
                        'upgrade',
                        setQuickActionOutput,
                        actionLabel('upgrade'),
                      )
                    }
                  >
                    {t('dashboard.oneClickUpgrade')}
                  </button>
                </div>
                <pre className="console">{quickActionOutput}</pre>
              </article>
            </section>
          )}

          {activeTab === 'services' && (
            <section className="card-grid two">
              <article className="card">
                <h3>{t('services.serviceManagement')}</h3>
                <div className="button-wrap">
                  {[
                    'version_check',
                    'gateway_install',
                    'gateway_uninstall',
                    'gateway_start',
                    'gateway_stop',
                    'gateway_restart',
                    'upgrade',
                  ].map((action) => (
                    <button
                      key={action}
                      onClick={() =>
                        void runServiceAction(action, setServiceOutput, actionLabel(action))
                      }
                    >
                      {actionLabel(action)}
                    </button>
                  ))}
                </div>
                <pre className="console">{serviceOutput}</pre>
              </article>

              <article className="card">
                <h3>{t('services.configBackupRestore')}</h3>
                <div className="row">
                  <button onClick={onCreateBackup}>{t('services.createBackup')}</button>
                  <button onClick={() => void loadBackups()}>{t('common.refresh')}</button>
                </div>
                <div className="row">
                  <select
                    value={selectedBackup}
                    onChange={(event) => setSelectedBackup(event.target.value)}
                  >
                    {backups.length === 0 && (
                      <option value="">{t('services.noBackups')}</option>
                    )}
                    {backups.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name} ({new Date(item.mtime * 1000).toLocaleString()})
                      </option>
                    ))}
                  </select>
                  <button className="danger" onClick={onRestoreBackup}>
                    {t('services.restoreBackup')}
                  </button>
                </div>
                <pre className="console">{backupOutput}</pre>
              </article>
            </section>
          )}

          {activeTab === 'models' && (
            <>
              <section className="card-grid three">
                <article className="card">
                  <div className="card-head">
                    <h3>{t('models.providers')}</h3>
                    <button onClick={onAddProvider}>{t('models.addProvider')}</button>
                  </div>
                  <div className="list-wrap">
                    {providers.map((provider, index) => (
                      <button
                        key={`${provider.key}-${index}`}
                        className={`list-item ${index === selectedProviderIndex ? 'active' : ''}`}
                        onClick={() => setSelectedProviderIndex(index)}
                      >
                        {provider.key}
                      </button>
                    ))}
                  </div>
                </article>

                <article className="card">
                  <h3>{t('models.providerEditor')}</h3>
                  {!selectedProvider ? (
                    <p className="muted-text">{t('models.selectOrCreateProvider')}</p>
                  ) : (
                    <div className="form-stack">
                      <label>
                        {t('models.key')}
                        <input
                          value={selectedProvider.key}
                          onChange={(event) => {
                            const next = [...providers]
                            next[selectedProviderIndex] = {
                              ...next[selectedProviderIndex],
                              key: normalizeProviderKey(event.target.value),
                            }
                            setProviders(next)
                            scheduleAutoSave()
                          }}
                        />
                      </label>
                      <label>
                        {t('models.name')}
                        <input
                          value={selectedProvider.name}
                          onChange={(event) => {
                            const next = [...providers]
                            next[selectedProviderIndex] = {
                              ...next[selectedProviderIndex],
                              name: event.target.value,
                            }
                            setProviders(next)
                            scheduleAutoSave()
                          }}
                        />
                      </label>
                      <label>
                        {t('models.apiBaseUrl')}
                        <input
                          value={selectedProvider.api}
                          onChange={(event) => {
                            const next = [...providers]
                            next[selectedProviderIndex] = {
                              ...next[selectedProviderIndex],
                              api: event.target.value,
                            }
                            setProviders(next)
                            scheduleAutoSave()
                          }}
                        />
                      </label>
                      <label>
                        {t('models.apiKey')}
                        <input
                          type="password"
                          value={selectedProvider.api_key}
                          onChange={(event) => {
                            const next = [...providers]
                            next[selectedProviderIndex] = {
                              ...next[selectedProviderIndex],
                              api_key: event.target.value,
                            }
                            setProviders(next)
                            scheduleAutoSave()
                          }}
                        />
                      </label>
                      <label>
                        {t('models.defaultModel')}
                        <input
                          value={selectedProvider.default_model}
                          onChange={(event) => {
                            const next = [...providers]
                            next[selectedProviderIndex] = {
                              ...next[selectedProviderIndex],
                              default_model: event.target.value,
                            }
                            setProviders(next)
                            scheduleAutoSave()
                          }}
                        />
                      </label>

                      <div className="card-head compact">
                        <h4>{t('models.models')}</h4>
                        <button onClick={onAddModel}>{t('models.addModel')}</button>
                      </div>

                      <div className="model-list">
                        {(selectedProvider.models || []).map((modelName, modelIndex) => (
                          <div key={`${modelName}-${modelIndex}`} className="row between">
                            <span>{modelName}</span>
                            <button
                              className="danger ghost"
                              onClick={() => {
                                const next = [...providers]
                                const models = [...(next[selectedProviderIndex].models || [])]
                                models.splice(modelIndex, 1)
                                next[selectedProviderIndex] = {
                                  ...next[selectedProviderIndex],
                                  models,
                                }
                                setProviders(next)
                                scheduleAutoSave()
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="row">
                        <button className="danger" onClick={onDeleteProvider}>
                          {t('models.deleteProvider')}
                        </button>
                        <button onClick={() => void testCurrentProvider()}>
                          {t('models.testProvider')}
                        </button>
                      </div>
                    </div>
                  )}
                </article>

                <article className="card">
                  <h3>{t('models.activeModelTarget')}</h3>
                  <div className="form-stack">
                    <label>
                      {t('models.providerMarker')}
                      <input
                        value={activeModel.provider}
                        onChange={(event) => {
                          setActiveModel((prev) => ({ ...prev, provider: event.target.value }))
                          scheduleAutoSave()
                        }}
                      />
                    </label>
                    <label>
                      {t('models.baseUrl')}
                      <input
                        value={activeModel.base_url}
                        onChange={(event) => {
                          setActiveModel((prev) => ({ ...prev, base_url: event.target.value }))
                          scheduleAutoSave()
                        }}
                      />
                    </label>
                    <label>
                      {t('models.apiKey')}
                      <input
                        type="password"
                        value={activeModel.api_key}
                        onChange={(event) => {
                          setActiveModel((prev) => ({ ...prev, api_key: event.target.value }))
                          scheduleAutoSave()
                        }}
                      />
                    </label>
                    <label>
                      {t('models.defaultModel')}
                      <input
                        value={activeModel.default}
                        onChange={(event) => {
                          setActiveModel((prev) => ({ ...prev, default: event.target.value }))
                          scheduleAutoSave()
                        }}
                      />
                    </label>
                    <button onClick={() => void testAllModels()}>{t('models.batchConnectivityTest')}</button>
                  </div>
                </article>
              </section>

              <section className="card-grid one">
                <article className="card">
                  <div className="card-head">
                    <h3>{t('models.rawYamlEditor')}</h3>
                    <button onClick={() => void saveRawYaml()}>{t('models.saveRawYaml')}</button>
                  </div>
                  <textarea
                    className="raw-editor"
                    spellCheck={false}
                    value={rawYaml}
                    onChange={(event) => setRawYaml(event.target.value)}
                  />
                </article>
              </section>

              <section className="card-grid one">
                <article className="card">
                  <h3>Model Test Result</h3>
                  <div className="test-results">
                    {testResults.map((item, index) => (
                      <div key={`${item.provider_key}-${item.model}-${index}`} className="test-item">
                        <strong>
                          {item.provider_key || 'unknown'} / {item.model}
                        </strong>
                        <span>
                          latency: {item.latency_ms ?? '--'}ms | status: {item.status_code}
                        </span>
                        <span>{item.error || 'ok'}</span>
                      </div>
                    ))}
                  </div>
                </article>
              </section>
            </>
          )}

          {activeTab === 'logs' && (
            <section className="card-grid one">
              <article className="card">
                <div className="card-head">
                  <h3>{t('logs.logViewer')}</h3>
                  <div className="row">
                    <select
                      value={selectedLogSource}
                      onChange={(event) => setSelectedLogSource(event.target.value)}
                    >
                      {logSources.length === 0 && <option value="">{t('logs.noLogSource')}</option>}
                      {logSources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.name}
                        </option>
                      ))}
                    </select>
                    <input
                      placeholder={t('logs.keywordFilter')}
                      value={logKeyword}
                      onChange={(event) => setLogKeyword(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          void refreshLogs()
                        }
                      }}
                    />
                    <button onClick={() => void refreshLogs()}>{t('common.refresh')}</button>
                    <label className="inline-check">
                      <input
                        type="checkbox"
                        checked={logAutoRefresh}
                        onChange={(event) => setLogAutoRefresh(event.target.checked)}
                      />
                      <span>{t('common.auto')}</span>
                    </label>
                  </div>
                </div>
                <pre className="console tall">{logOutput}</pre>
              </article>
            </section>
          )}

          {activeTab === 'chat' && (
            <section className="card-grid one">
              <article className="card chat-card">
                <div className="card-head">
                  <h3>{t('chat.streamingChat')}</h3>
                  <div className="row">
                    <select
                      value={chatProvider}
                      onChange={(event) => setChatProvider(event.target.value)}
                    >
                      <option value="">{t('chat.auto')}</option>
                      {providers.map((provider) => (
                        <option key={provider.key} value={provider.key}>
                          {provider.key} ({provider.default_model || 'no default'})
                        </option>
                      ))}
                    </select>
                    <input
                      value={chatModelOverride}
                      placeholder={t('chat.modelOverride')}
                      onChange={(event) => setChatModelOverride(event.target.value)}
                    />
                  </div>
                </div>

                <div className="chat-messages">
                  {chatMessages.map((message, index) => (
                    <div key={`${message.role}-${index}`} className={`chat-msg ${message.role}`}>
                      <pre>{message.content}</pre>
                    </div>
                  ))}
                </div>

                <form className="chat-form" onSubmit={onSendChat}>
                  <textarea
                    required
                    value={chatInput}
                    placeholder={t('chat.typeQuestion')}
                    onChange={(event) => setChatInput(event.target.value)}
                  />
                  <button type="submit">{t('chat.send')}</button>
                </form>
              </article>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
