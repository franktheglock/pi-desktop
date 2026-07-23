/**
 * Browser stand-in for the Electron preload bridge. Talks to the LAN server's
 * /api/invoke + /api/events SSE using the same channel names as ipcMain.
 */
import { IPC_CHANNELS } from '../../shared/ipc-contracts'

const TOKEN_KEY = 'pi_lan_token'

function getToken(): string {
  const q = new URLSearchParams(window.location.search).get('token')
  if (q) {
    try {
      localStorage.setItem(TOKEN_KEY, q)
    } catch {
      // ignore
    }
    return q
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const token = getToken()
  const res = await fetch('/api/invoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, args }),
  })
  const body = (await res.json()) as { ok?: boolean; result?: T; error?: string }
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || res.statusText || 'IPC invoke failed')
  }
  return body.result as T
}

type Listener = (data: unknown) => void
const listeners = new Map<string, Set<Listener>>()

function onChannel(channel: string, cb: Listener): () => void {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(cb)
  return () => {
    set!.delete(cb)
  }
}

let es: EventSource | null = null

function connectEvents(): void {
  if (es) es.close()
  const token = getToken()
  if (!token) return
  es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`)
  es.addEventListener('ipc', (ev) => {
    try {
      const msg = JSON.parse((ev as MessageEvent).data) as { channel: string; data: unknown }
      const set = listeners.get(msg.channel)
      if (!set) return
      for (const cb of set) cb(msg.data)
    } catch {
      // ignore bad frames
    }
  })
}

/** Install window.piDesktop for remote (non-Electron) sessions. */
export function installRemoteBridge(): void {
  if (typeof window === 'undefined') return
  // Already provided by Electron preload
  if ((window as unknown as { piDesktop?: unknown }).piDesktop && !(window as unknown as { __PI_REMOTE__?: boolean }).__PI_REMOTE__) {
    return
  }

  connectEvents()

  const api = {
    pi: {
      start: (options?: unknown) => invoke(IPC_CHANNELS.PI_START, options),
      stop: () => invoke(IPC_CHANNELS.PI_STOP),
      restart: (options?: unknown) => invoke(IPC_CHANNELS.PI_RESTART, options),
      getStatus: () => invoke(IPC_CHANNELS.PI_STATUS),
    },
    commands: {
      prompt: (message: string, options?: unknown) => invoke(IPC_CHANNELS.PI_PROMPT, message, options),
      steer: (message: string, images?: unknown) => invoke(IPC_CHANNELS.PI_STEER, message, images),
      followUp: (message: string) => invoke(IPC_CHANNELS.PI_FOLLOW_UP, message),
      abort: () => invoke(IPC_CHANNELS.PI_ABORT),
      bash: (command: string) => invoke(IPC_CHANNELS.PI_BASH, command),
      abortBash: () => invoke(IPC_CHANNELS.PI_ABORT_BASH),
    },
    session: {
      createNew: () => invoke(IPC_CHANNELS.SESSION_NEW),
      switch: (sessionPath: string) => invoke(IPC_CHANNELS.SESSION_SWITCH, sessionPath),
      fork: (entryId?: string) => invoke(IPC_CHANNELS.SESSION_FORK, entryId),
      clone: () => invoke(IPC_CHANNELS.SESSION_CLONE),
      list: (cwd?: string) => invoke(IPC_CHANNELS.SESSION_LIST, cwd),
      listAll: (cwd?: string) => invoke(IPC_CHANNELS.SESSION_LIST_ALL, cwd),
      getState: () => invoke(IPC_CHANNELS.SESSION_GET_STATE),
      getMessages: () => invoke(IPC_CHANNELS.SESSION_GET_MESSAGES),
      getStats: () => invoke(IPC_CHANNELS.SESSION_GET_STATS),
      setName: (name: string) => invoke(IPC_CHANNELS.SESSION_SET_NAME, name),
      exportHtml: (outputPath?: string) => invoke(IPC_CHANNELS.SESSION_EXPORT_HTML, outputPath),
      getForkMessages: () => invoke(IPC_CHANNELS.SESSION_GET_FORK_MESSAGES),
      getLineage: () => invoke(IPC_CHANNELS.SESSION_GET_LINEAGE),
      compact: (customInstructions?: string) => invoke(IPC_CHANNELS.SESSION_COMPACT, customInstructions),
      delete: (sessionPath: string) => invoke(IPC_CHANNELS.SESSION_DELETE, sessionPath),
      archive: (sessionId: string) => invoke(IPC_CHANNELS.SESSION_ARCHIVE, sessionId),
      unarchive: (sessionId: string) => invoke(IPC_CHANNELS.SESSION_UNARCHIVE, sessionId),
      listArchived: () => invoke(IPC_CHANNELS.SESSION_LIST_ARCHIVED),
    },
    model: {
      set: (provider: string, modelId: string) => invoke(IPC_CHANNELS.MODEL_SET, provider, modelId),
      cycle: () => invoke(IPC_CHANNELS.MODEL_CYCLE),
      listAvailable: () => invoke(IPC_CHANNELS.MODEL_LIST_AVAILABLE),
    },
    thinking: {
      setLevel: (level: string) => invoke(IPC_CHANNELS.THINKING_SET_LEVEL, level),
      cycleLevel: () => invoke(IPC_CHANNELS.THINKING_CYCLE_LEVEL),
    },
    settings: {
      getAll: () => invoke(IPC_CHANNELS.SETTINGS_GET_ALL),
      save: (settings: unknown) => invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),
    },
    lan: {
      getStatus: () => invoke(IPC_CHANNELS.LAN_GET_STATUS),
      apply: (options?: unknown) => invoke(IPC_CHANNELS.LAN_APPLY, options),
      regenerateToken: () => invoke(IPC_CHANNELS.LAN_REGENERATE_TOKEN),
    },
    permissionRules: {
      get: (scope: unknown) => invoke(IPC_CHANNELS.PERMISSION_RULES_GET, scope),
      set: (scope: unknown, rules: unknown) => invoke(IPC_CHANNELS.PERMISSION_RULES_SET, scope, rules),
      importFromFile: () => invoke(IPC_CHANNELS.PERMISSION_RULES_IMPORT),
      exportToFile: (rules: unknown) => invoke(IPC_CHANNELS.PERMISSION_RULES_EXPORT, rules),
      workspaceStatus: () => invoke(IPC_CHANNELS.PERMISSION_RULES_WORKSPACE_STATUS),
      removeWorkspace: () => invoke(IPC_CHANNELS.PERMISSION_RULES_REMOVE_WORKSPACE),
    },
    themes: {
      list: () => invoke(IPC_CHANNELS.THEMES_LIST),
      save: (file: unknown, existingId?: string) => invoke(IPC_CHANNELS.THEMES_SAVE, file, existingId),
      delete: (id: string) => invoke(IPC_CHANNELS.THEMES_DELETE, id),
      installFromUrl: (url: string) => invoke(IPC_CHANNELS.THEMES_INSTALL_URL, url),
      export: (file: unknown) => invoke(IPC_CHANNELS.THEMES_EXPORT, file),
      import: () => invoke(IPC_CHANNELS.THEMES_IMPORT),
      gallery: () => invoke(IPC_CHANNELS.THEMES_GALLERY_LIST),
      galleryImage: (url: string) => invoke(IPC_CHANNELS.THEMES_GALLERY_IMAGE, url),
    },
    workspace: {
      list: () => invoke(IPC_CHANNELS.WORKSPACE_LIST),
      create: (name: string, path: string) => invoke(IPC_CHANNELS.WORKSPACE_CREATE, name, path),
      remove: (workspaceId: string) => invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId),
      rename: (workspaceId: string, name: string) => invoke(IPC_CHANNELS.WORKSPACE_RENAME, workspaceId, name),
      changePath: (workspaceId: string, newPath: string) =>
        invoke(IPC_CHANNELS.WORKSPACE_CHANGE_PATH, workspaceId, newPath),
      pathExists: () => invoke(IPC_CHANNELS.WORKSPACE_PATH_EXISTS),
      setActive: (workspaceId: string) => invoke(IPC_CHANNELS.WORKSPACE_SET_ACTIVE, workspaceId),
      getActive: () => invoke(IPC_CHANNELS.WORKSPACE_GET_ACTIVE),
      startPi: (workspaceId: string, options?: unknown) =>
        invoke(IPC_CHANNELS.WORKSPACE_START_PI, workspaceId, options),
      stopPi: (workspaceId: string) => invoke(IPC_CHANNELS.WORKSPACE_STOP_PI, workspaceId),
    },
    packages: {
      listInstalled: () => invoke(IPC_CHANNELS.PACKAGE_LIST_INSTALLED),
      install: (spec: string) => invoke(IPC_CHANNELS.PACKAGE_INSTALL, spec),
      remove: (spec: string) => invoke(IPC_CHANNELS.PACKAGE_REMOVE, spec),
      update: (spec?: string) => invoke(IPC_CHANNELS.PACKAGE_UPDATE, spec),
      fetchCatalog: (query?: string) => invoke(IPC_CHANNELS.PACKAGE_CATALOG_FETCH, query),
    },
    models: {
      read: () => invoke(IPC_CHANNELS.MODELS_READ),
      write: (config: unknown) => invoke(IPC_CHANNELS.MODELS_WRITE, config),
    },
    council: {
      detect: () => invoke(IPC_CHANNELS.COUNCIL_DETECT),
      runConsultants: (payload: unknown) => invoke(IPC_CHANNELS.COUNCIL_RUN_CONSULTANTS, payload),
      arbiter: (payload: unknown) => invoke(IPC_CHANNELS.COUNCIL_ARBITER, payload),
      onProgress: (callback: (event: unknown) => void) =>
        onChannel(IPC_CHANNELS.EVENT_COUNCIL_PROGRESS, callback),
    },
    skills: {
      list: () => invoke(IPC_CHANNELS.SKILLS_LIST),
    },
    piCommands: {
      list: () => invoke(IPC_CHANNELS.COMMANDS_LIST),
    },
    mcpServers: {
      list: () => invoke(IPC_CHANNELS.MCP_SERVERS_LIST),
    },
    tags: {
      get: (sessionId: string) => invoke(IPC_CHANNELS.TAG_GET, sessionId),
      set: (sessionId: string, tags: string[]) => invoke(IPC_CHANNELS.TAG_SET, sessionId, tags),
      add: (sessionId: string, tag: string) => invoke(IPC_CHANNELS.TAG_ADD, sessionId, tag),
      remove: (sessionId: string, tag: string) => invoke(IPC_CHANNELS.TAG_REMOVE, sessionId, tag),
      getAll: () => invoke(IPC_CHANNELS.TAG_GET_ALL),
      getAllUsed: () => invoke(IPC_CHANNELS.TAG_GET_ALL_USED),
      autoGetAll: () => invoke(IPC_CHANNELS.TAG_AUTO_GET_ALL),
      autoEnsure: (sessions: unknown) => invoke(IPC_CHANNELS.TAG_AUTO_ENSURE, sessions),
      autoRemove: (sessionId: string) => invoke(IPC_CHANNELS.TAG_AUTO_REMOVE, sessionId),
    },
    notes: {
      list: () => invoke(IPC_CHANNELS.NOTES_LIST),
      create: (input: unknown) => invoke(IPC_CHANNELS.NOTES_CREATE, input),
      update: (id: string, patch: unknown) => invoke(IPC_CHANNELS.NOTES_UPDATE, id, patch),
      remove: (id: string) => invoke(IPC_CHANNELS.NOTES_REMOVE, id),
    },
    files: {
      getTree: (maxDepth?: number) => invoke(IPC_CHANNELS.FILE_TREE, maxDepth),
      search: (query: string) => invoke(IPC_CHANNELS.FILE_SEARCH, query),
      searchContent: (query: string) => invoke(IPC_CHANNELS.FILE_SEARCH_CONTENT, query),
      read: (path: string) => invoke(IPC_CHANNELS.FILE_READ, path),
      readAttachment: (path: string) => invoke(IPC_CHANNELS.FILE_READ_ATTACHMENT, path),
      write: (path: string, content: string) => invoke(IPC_CHANNELS.FILE_WRITE, path, content),
      getDiff: (filePath?: string) => invoke(IPC_CHANNELS.FILE_DIFF, filePath),
      getStagedDiff: (filePath?: string) => invoke(IPC_CHANNELS.FILE_STAGED_DIFF, filePath),
      getGitStatus: () => invoke(IPC_CHANNELS.GIT_STATUS),
      getGitBranch: () => invoke(IPC_CHANNELS.GIT_BRANCH),
    },
    system: {
      openDialog: (options?: unknown) => invoke(IPC_CHANNELS.SYSTEM_OPEN_DIALOG, options),
      getPath: (name: string) => invoke(IPC_CHANNELS.SYSTEM_GET_PATH, name),
      openExternal: (url: string) => invoke(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, url),
      getVersion: () => invoke(IPC_CHANNELS.SYSTEM_GET_VERSION),
    },
    activity: {
      getStats: () => invoke(IPC_CHANNELS.ACTIVITY_GET_STATS),
    },
    updates: {
      check: () => invoke(IPC_CHANNELS.UPDATE_CHECK),
    },
    terminal: {
      start: (options?: unknown) => invoke(IPC_CHANNELS.TERMINAL_START, options),
      input: (data: string) => invoke(IPC_CHANNELS.TERMINAL_INPUT, data),
      resize: (cols: number, rows: number) => invoke(IPC_CHANNELS.TERMINAL_RESIZE, { cols, rows }),
      stop: () => invoke(IPC_CHANNELS.TERMINAL_STOP),
      onData: (callback: (data: string) => void) =>
        onChannel(IPC_CHANNELS.EVENT_TERMINAL_DATA, (d) => callback(d as string)),
      onExit: (callback: (event: unknown) => void) =>
        onChannel(IPC_CHANNELS.EVENT_TERMINAL_EXIT, callback),
    },
    ui: {
      respondSelect: (id: string, value: string) => {
        void invoke(IPC_CHANNELS.UI_SELECT_RESPONSE, id, value)
      },
      respondConfirm: (id: string, confirmed: boolean) => {
        void invoke(IPC_CHANNELS.UI_CONFIRM_RESPONSE, id, confirmed)
      },
      respondInput: (id: string, value: string) => {
        void invoke(IPC_CHANNELS.UI_INPUT_RESPONSE, id, value)
      },
      respondEditor: (id: string, value: string) => {
        void invoke(IPC_CHANNELS.UI_EDITOR_RESPONSE, id, value)
      },
    },
    onEvent: (callback: (event: unknown) => void) => onChannel(IPC_CHANNELS.EVENT_PI, callback),
    onFileChange: (callback: (event: unknown) => void) =>
      onChannel(IPC_CHANNELS.EVENT_FILE_CHANGE, callback),
    onMenuAction: (_callback: (action: string) => void) => () => {
      // No native menu over LAN
    },
  }

  ;(window as unknown as { piDesktop: typeof api }).piDesktop = api
  document.documentElement.classList.add('pi-remote')
}
