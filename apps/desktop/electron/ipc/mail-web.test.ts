import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const mocks = vi.hoisted(() => ({ guests: [] as any[], sessions: new Map<string, any>(), host: null as any, external: vi.fn(async () => {}) }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => mocks.host },
  ipcMain: { handle: vi.fn(), on: vi.fn() }, net: {}, shell: { openExternal: mocks.external },
  session: { fromPartition: (partition: string) => {
    if (!mocks.sessions.has(partition)) mocks.sessions.set(partition, { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), on: vi.fn() })
    return mocks.sessions.get(partition)
  } },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, loadURL: vi.fn(async () => {}), getURL: vi.fn(() => ''), close: vi.fn(), setWindowOpenHandler: vi.fn() })
    setVisible = vi.fn(); setBounds = vi.fn(); setBackgroundColor = vi.fn(); setBorderRadius = vi.fn()
    constructor(public options: any) { mocks.guests.push(this) }
  }
}))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
import { WebViews } from './web.ts'

describe('native isolated mail view', () => {
  let owner: any
  beforeEach(() => {
    mocks.guests.length = 0
    mocks.external.mockClear()
    owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn(), getZoomFactor: () => 1 })
    mocks.host = { isDestroyed: () => false, webContents: owner, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
  })
  it('uses a separate sandboxed partition with no preload and enforces ownership', () => {
    const views = new WebViews(true)
    const id = views.openMail(owner, 'http://127.0.0.1:8097')
    const guest = mocks.guests[0]
    expect(guest.options.webPreferences).toMatchObject({ partition: 'persist:herald-mail', sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(guest.options.webPreferences.preload).toBeUndefined()
    expect(guest.webContents.loadURL).toHaveBeenCalledWith('http://127.0.0.1:8097/tablero?herald=1')
    expect(() => views.navigateMail({} as any, id, '/lista')).toThrow()
    views.navigateMail(owner, id, '/correo/MAIL-4')
    expect(guest.webContents.loadURL).toHaveBeenLastCalledWith('http://127.0.0.1:8097/correo/MAIL-4?herald=1')
    views.close(id, owner)
    expect(guest.webContents.close).toHaveBeenCalled()
    expect(() => views.navigateMail(owner, id, '/lista')).toThrow()
  })
  it('blocks cross-origin redirects and invalid SPA routes and strips private failure details', () => {
    const views = new WebViews(true)
    views.openMail(owner, 'http://127.0.0.1:8097')
    const contents = mocks.guests[0].webContents
    const event = { preventDefault: vi.fn() }
    contents.emit('will-redirect', event, 'https://example.com/?secret=value')
    expect(event.preventDefault).toHaveBeenCalled()
    contents.getURL.mockReturnValue('http://127.0.0.1:8097/home')
    contents.emit('did-navigate-in-page', {}, 'http://127.0.0.1:8097/home', true)
    expect(contents.loadURL).toHaveBeenLastCalledWith('http://127.0.0.1:8097/tablero?herald=1')
    contents.emit('did-fail-load', {}, -105, 'sensitive detail', 'http://127.0.0.1:8097/?token=secret', true)
    const serialized = JSON.stringify(owner.send.mock.calls)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('sensitive detail')
    expect(serialized).toContain('No se pudo cargar')
  })
  it('keeps Outlook links separate and blocks other popup destinations', () => {
    const views = new WebViews(true)
    views.openMail(owner, 'http://127.0.0.1:8097')
    const contents = mocks.guests[0].webContents
    const popup = contents.setWindowOpenHandler.mock.calls[0][0]
    expect(popup({ url: 'https://outlook.office.com/mail/inbox/id/abc' })).toEqual({ action: 'deny' })
    expect(mocks.external).toHaveBeenCalledTimes(1)
    popup({ url: 'https://attacker.example/mail' })
    popup({ url: 'https://user:secret@outlook.office.com/mail/inbox' })
    expect(mocks.external).toHaveBeenCalledTimes(1)
  })

  it('reports main-frame completion and ignores nested mail iframe loading', () => {
    const views = new WebViews(true)
    views.openMail(owner, 'http://127.0.0.1:8097')
    const contents = mocks.guests[0].webContents
    contents.getURL.mockReturnValue('http://127.0.0.1:8097/correo/MAIL-1')
    contents.emit('did-start-navigation', {}, contents.getURL(), false, true)
    contents.emit('did-finish-load')
    expect(owner.send.mock.calls.map((call: any[]) => call[1])).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'loading', loading: true }),
      expect.objectContaining({ type: 'url', url: contents.getURL() }),
      expect.objectContaining({ type: 'loading', loading: false })
    ]))
    owner.send.mockClear()
    contents.emit('did-start-loading')
    contents.emit('did-start-navigation', {}, 'about:blank', false, false)
    contents.emit('did-stop-loading')
    expect(owner.send).not.toHaveBeenCalled()
  })
})
