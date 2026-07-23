/**
 * Shared IPC handler registry so Electron `ipcMain.handle` and the LAN remote
 * server can invoke the same handlers.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

type Handler = (event: IpcMainInvokeEvent | null, ...args: unknown[]) => unknown | Promise<unknown>

const handlers = new Map<string, Handler>()

export function registerIpcHandler(channel: string, handler: Handler): void {
  handlers.set(channel, handler)
  ipcMain.handle(channel, (event, ...args: unknown[]) => handler(event, ...args))
}

export async function invokeIpcHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`No IPC handler registered for channel: ${channel}`)
  }
  return handler(null, ...args)
}

export function hasIpcHandler(channel: string): boolean {
  return handlers.has(channel)
}
