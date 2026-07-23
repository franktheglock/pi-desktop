/**
 * LAN remote: HTTP server that serves the full Pi Desktop renderer and proxies
 * the same IPC surface over REST + SSE so phones get feature parity with the
 * desktop shell (same React app, same handlers).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { randomBytes } from 'crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'fs'
import { extname, join, normalize } from 'path'
import { app } from 'electron'
import type { WorkspaceManager } from './workspace-manager'
import { invokeIpcHandler } from './ipc-registry'

export const DEFAULT_LAN_PORT = 4747

export interface LanServerConfig {
  enabled: boolean
  port: number
  token: string
}

export interface LanServerStatus {
  running: boolean
  port: number
  token: string
  urls: string[]
  error: string | null
}

type SseClient = { res: ServerResponse; id: number }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
}

export function generateLanToken(): string {
  return randomBytes(18).toString('base64url')
}

export function listLanAddresses(): string[] {
  const nets = networkInterfaces()
  const out: string[] = []
  for (const entries of Object.values(nets)) {
    if (!entries) continue
    for (const e of entries) {
      if (e.family === 'IPv4' && !e.internal) out.push(e.address)
    }
  }
  return out
}

export function buildLanUrls(port: number): string[] {
  const addrs = listLanAddresses()
  const hosts = addrs.length > 0 ? addrs : ['127.0.0.1']
  return hosts.map((h) => `http://${h}:${port}`)
}

/** Built renderer root (full React app). */
export function resolveRendererRoot(): string {
  const candidates = [
    join(app.getAppPath(), 'out', 'renderer'),
    join(process.resourcesPath ?? '', 'app.asar.unpacked', 'out', 'renderer'),
    join(process.resourcesPath ?? '', 'app', 'out', 'renderer'),
    join(__dirname, '../../out/renderer'),
    join(process.cwd(), 'out/renderer'),
  ]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'index.html'))) return dir
  }
  return candidates[candidates.length - 1]
}

function readBody(req: IncomingMessage, limit = 8_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(data)
}

export class LanServer {
  private server: Server | null = null
  private config: LanServerConfig = { enabled: false, port: DEFAULT_LAN_PORT, token: '' }
  private error: string | null = null
  private sseClients = new Map<number, SseClient>()
  private nextSseId = 1
  private rendererRoot = resolveRendererRoot()

  constructor(private readonly _workspaceManager: WorkspaceManager) {
    void this._workspaceManager
  }

  getStatus(): LanServerStatus {
    const running = this.server !== null
    return {
      running,
      port: this.config.port,
      token: this.config.token,
      urls: running ? buildLanUrls(this.config.port) : [],
      error: this.error,
    }
  }

  async applyConfig(partial: Partial<LanServerConfig>): Promise<LanServerStatus> {
    const next: LanServerConfig = {
      enabled: partial.enabled ?? this.config.enabled,
      port: partial.port ?? this.config.port,
      token: partial.token ?? this.config.token,
    }
    if (!next.token) next.token = generateLanToken()
    if (next.port < 1 || next.port > 65535) next.port = DEFAULT_LAN_PORT

    const wasRunning = this.server !== null
    const changed =
      next.enabled !== this.config.enabled ||
      next.port !== this.config.port ||
      next.token !== this.config.token

    this.config = next

    if (!next.enabled) {
      await this.stop()
      return this.getStatus()
    }
    if (wasRunning && changed) await this.stop()
    if (!this.server) await this.start()
    return this.getStatus()
  }

  async start(): Promise<void> {
    if (this.server) return
    this.error = null
    this.rendererRoot = resolveRendererRoot()
    if (!existsSync(join(this.rendererRoot, 'index.html'))) {
      this.error = `Renderer not found at ${this.rendererRoot}. Run a full build first.`
      throw new Error(this.error)
    }

    const server = createServer((req, res) => {
      void this.handle(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.message
        this.server = null
        reject(err)
      })
      server.listen(this.config.port, '0.0.0.0', () => {
        this.server = server
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients.values()) {
      try {
        client.res.end()
      } catch {
        // ignore
      }
    }
    this.sseClients.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  /** Push an IPC event channel payload to all SSE clients. */
  publishEvent(channel: string, data: unknown): void {
    if (this.sseClients.size === 0) return
    const payload = `event: ipc\ndata: ${JSON.stringify({ channel, data })}\n\n`
    for (const [id, client] of this.sseClients) {
      try {
        client.res.write(payload)
      } catch {
        this.sseClients.delete(id)
      }
    }
  }

  /** @deprecated use publishEvent */
  publishPiEvent(event: unknown): void {
    this.publishEvent('event:pi', event)
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const token = this.config.token
    if (!token) return false
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ') && header.slice(7) === token) return true
    if (url.searchParams.get('token') === token) return true
    const cookie = req.headers.cookie ?? ''
    if (cookie.split(';').some((c) => c.trim() === `pi_lan_token=${token}`)) return true
    return false
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const host = req.headers.host ?? `127.0.0.1:${this.config.port}`
      const url = new URL(req.url ?? '/', `http://${host}`)
      const path = url.pathname

      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (path === '/api/health') {
        sendJson(res, 200, { ok: true, renderer: existsSync(join(this.rendererRoot, 'index.html')) })
        return
      }

      if (path === '/api/login' && req.method === 'POST') {
        const raw = await readBody(req)
        let body: { token?: string } = {}
        try {
          body = JSON.parse(raw) as { token?: string }
        } catch {
          body = {}
        }
        if (body.token !== this.config.token) {
          sendJson(res, 401, { error: 'Invalid token' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `pi_lan_token=${this.config.token}; Path=/; SameSite=Lax; HttpOnly`,
        })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // Auth gate for API (except login/health)
      if (path.startsWith('/api/')) {
        if (!this.isAuthorized(req, url)) {
          sendJson(res, 401, { error: 'Unauthorized' })
          return
        }
      }

      if (path === '/api/invoke' && req.method === 'POST') {
        const raw = await readBody(req)
        let channel = ''
        let args: unknown[] = []
        try {
          const body = JSON.parse(raw) as { channel?: string; args?: unknown[] }
          channel = typeof body.channel === 'string' ? body.channel : ''
          args = Array.isArray(body.args) ? body.args : []
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON' })
          return
        }
        if (!channel) {
          sendJson(res, 400, { error: 'channel required' })
          return
        }
        try {
          const result = await invokeIpcHandler(channel, ...args)
          sendJson(res, 200, { ok: true, result })
        } catch (err) {
          sendJson(res, 500, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }

      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        })
        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        const id = this.nextSseId++
        this.sseClients.set(id, { res, id })
        req.on('close', () => {
          this.sseClients.delete(id)
        })
        return
      }

      // Static app shell: public (useless without API). API stays token-gated.
      // If ?token= matches, set cookie so subsequent API/SSE work from this browser.
      if (url.searchParams.get('token') === this.config.token) {
        res.setHeader(
          'Set-Cookie',
          `pi_lan_token=${this.config.token}; Path=/; SameSite=Lax; HttpOnly`
        )
      } else if (
        (path === '/' || path.endsWith('.html')) &&
        path !== '/login.html' &&
        !this.isAuthorized(req, url)
      ) {
        res.writeHead(302, { Location: '/login.html' })
        res.end()
        return
      }

      await this.serveStatic(res, path)
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    // Prefer login page from resources; app from built renderer
    if (pathname === '/login.html' || pathname === '/login.css' || pathname === '/login.js') {
      const loginRoot = resolveLoginRoot()
      const name = pathname === '/login.html' ? 'login.html' : pathname.slice(1)
      const filePath = join(loginRoot, name)
      if (existsSync(filePath)) {
        const ext = extname(filePath).toLowerCase()
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
        createReadStream(filePath).pipe(res)
        return
      }
    }

    let rel = pathname === '/' ? '/index.html' : pathname
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
    if (rel.includes('..')) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    const root = normalize(this.rendererRoot)
    const filePath = normalize(join(root, rel))
    const rootPrefix = root.endsWith('\\') || root.endsWith('/') ? root : root + (process.platform === 'win32' ? '\\' : '/')
    const rootOk =
      process.platform === 'win32'
        ? filePath.toLowerCase().startsWith(rootPrefix.toLowerCase())
        : filePath.startsWith(rootPrefix)

    if (!rootOk) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA fallback — inject remote bootstrap into index.html
      const index = join(root, 'index.html')
      if (existsSync(index)) {
        this.serveAppIndex(res, index)
        return
      }
      res.writeHead(404)
      res.end('App not built. Run npm run build first.')
      return
    }

    if (filePath.endsWith('index.html')) {
      this.serveAppIndex(res, filePath)
      return
    }

    const ext = extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
    createReadStream(filePath).pipe(res)
  }

  /** Serve index.html with remote-bridge bootstrapping flag. */
  private serveAppIndex(res: ServerResponse, indexPath: string): void {
    let html = readFileSync(indexPath, 'utf8')
    // Mark remote mode before modules load
    if (!html.includes('data-pi-remote')) {
      html = html.replace(
        '<head>',
        `<head>\n    <script>window.__PI_REMOTE__=true;</script>`
      )
    }
    // Loosen CSP for remote (same origin API + EventSource)
    html = html.replace(
      /content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'"/,
      `content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:"`
    )
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  }
}

function resolveLoginRoot(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'resources', 'lan-web'),
    join(app.getAppPath(), 'resources', 'lan-web'),
    join(__dirname, '../../resources/lan-web'),
    join(process.cwd(), 'resources/lan-web'),
  ]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'login.html'))) return dir
  }
  return candidates[candidates.length - 1]
}

let lanServerSingleton: LanServer | null = null

export function getLanServer(): LanServer | null {
  return lanServerSingleton
}

export function createLanServer(workspaceManager: WorkspaceManager): LanServer {
  lanServerSingleton = new LanServer(workspaceManager)
  return lanServerSingleton
}
