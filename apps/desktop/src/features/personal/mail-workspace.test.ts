import { describe, expect, it, vi } from 'vitest'
import type { WebViewEvent } from '../../../shared/ipc.ts'
import { createMailWorkspaceController, parseMailSelection, type MailWorkspaceBridge } from './mail-workspace.ts'

const baseUrl = 'http://localhost:8097'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function fixture() {
  let listener: ((event: WebViewEvent) => void) | null = null
  const stop = vi.fn(() => { listener = null })
  const bridge: MailWorkspaceBridge = {
    open: vi.fn(async () => ({ id: 'mail-view-1', baseUrl })),
    navigate: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    onEvent: vi.fn(fn => { listener = fn; return stop })
  }
  const controller = createMailWorkspaceController(bridge)
  const event = (value: WebViewEvent) => listener?.(value)
  const ready = (url = `${baseUrl}/tablero?herald=1`) => {
    event({ id: 'mail-view-1', type: 'url', url })
    event({ id: 'mail-view-1', type: 'loading', loading: false })
  }
  return { bridge, controller, event, ready, stop }
}

describe('trusted mail workspace selection', () => {
  it('extracts only the stable MAIL key from a real guest URL on the configured origin', () => {
    expect(parseMailSelection(`${baseUrl}/correo/MAIL-243?de=%2Flista%3Fq%3Dprivado&herald=1`, baseUrl)).toBe('MAIL-243')
  })

  it.each([
    'https://attacker.test/correo/MAIL-243',
    'http://localhost:8098/correo/MAIL-243',
    'http://localhost:8097.attacker.test/correo/MAIL-243',
    'http://user:secret@localhost:8097/correo/MAIL-243',
    'http://localhost:8097/lista?clave=MAIL-243',
    'http://localhost:8097/correo/MAIL-0',
    'http://localhost:8097/correo/MAIL-01',
    'http://localhost:8097/correo/MAIL-243/another',
    'http://localhost:8097/correo/MAIL-243%2Fanything',
    'http://localhost:8097/correo/mail-243',
    'file:///correo/MAIL-243',
    'not-a-url'
  ])('does not transfer untrusted or ambiguous context from %s', url => {
    expect(parseMailSelection(url, baseUrl)).toBeNull()
  })
})

describe('embedded mail workspace lifecycle', () => {
  it('keeps an open composer alive and rejects full navigation or reload until it closes', async () => {
    const { controller, bridge, ready } = fixture()
    await controller.open()
    const url = `${baseUrl}/correo/MAIL-4?redactar=96c1d56b-51db-4c2e-91de-c3c5a6f18449&herald=1`
    ready(url)
    await expect(controller.navigate('/lista')).rejects.toThrow(/cierra el editor/i)
    await expect(controller.reload()).rejects.toThrow(/cierra el editor/i)
    await controller.open()
    expect(controller.state.get()).toMatchObject({ phase: 'ready', selectedClave: 'MAIL-4', url })
    expect(bridge.navigate).not.toHaveBeenCalled()
    expect(bridge.reload).not.toHaveBeenCalled()
    expect(bridge.close).not.toHaveBeenCalled()
    expect(bridge.open).toHaveBeenCalledOnce()
    ready(`${baseUrl}/correo/MAIL-4?herald=1`)
    await controller.navigate('/lista')
    expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith('mail-view-1', '/lista')
    controller.dispose()
  })

  it('opens one native view and waits for its loaded guest document', async () => {
    const { controller, bridge, event } = fixture()
    await Promise.all([controller.open(), controller.open()])
    expect(bridge.open).toHaveBeenCalledExactlyOnceWith('/tablero')
    expect(controller.state.get()).toMatchObject({ phase: 'loading', viewId: 'mail-view-1', selectedClave: null })
    event({ id: 'mail-view-1', type: 'loading', loading: false })
    expect(controller.state.get().phase).toBe('loading')
    event({ id: 'mail-view-1', type: 'url', url: `${baseUrl}/tablero?herald=1` })
    expect(controller.state.get().phase).toBe('ready')
    controller.dispose()
  })

  it('does not lose initial load events emitted before open resolves', async () => {
    const { controller, bridge, event, ready } = fixture()
    const opening = deferred<{ id: string; baseUrl: string }>()
    vi.mocked(bridge.open).mockReturnValue(opening.promise)
    const wait = controller.open()
    ready(`${baseUrl}/correo/MAIL-9?herald=1`)
    event({ id: 'other-view', type: 'error', error: 'Unrelated' })
    opening.resolve({ id: 'mail-view-1', baseUrl })
    await wait
    expect(controller.state.get()).toMatchObject({ phase: 'ready', selectedClave: 'MAIL-9', error: null })
    controller.dispose()
  })

  it('shows an unavailable service failure and retries explicitly without another mail data source', async () => {
    const { controller, bridge, ready } = fixture()
    vi.mocked(bridge.open).mockRejectedValueOnce(new Error('Ingelmec Mail no está disponible en el puerto configurado.'))
    await controller.open()
    expect(controller.state.get()).toMatchObject({ phase: 'error', viewId: null, selectedClave: null, error: 'Ingelmec Mail no está disponible en el puerto configurado.' })
    await controller.reload()
    ready()
    expect(bridge.open).toHaveBeenCalledTimes(2)
    expect(controller.state.get().phase).toBe('ready')
    controller.dispose()
  })

  it('keeps a main-frame load failure visible after did-stop-loading', async () => {
    const { controller, event, ready } = fixture()
    await controller.open()
    ready(`${baseUrl}/correo/MAIL-8?herald=1`)
    event({ id: 'mail-view-1', type: 'error', error: 'No se pudo cargar el correo.' })
    event({ id: 'mail-view-1', type: 'loading', loading: false })
    expect(controller.state.get()).toMatchObject({ phase: 'error', error: 'No se pudo cargar el correo.', selectedClave: null })
    controller.dispose()
  })

  it('ignores lifecycle and close events belonging to another native view', async () => {
    const { controller, event, ready } = fixture()
    await controller.open()
    ready(`${baseUrl}/correo/MAIL-4?herald=1`)
    event({ id: 'other', type: 'error', error: 'Other failure' })
    event({ id: 'other', type: 'closed' })
    expect(controller.state.get()).toMatchObject({ phase: 'ready', viewId: 'mail-view-1', selectedClave: 'MAIL-4' })
    controller.dispose()
  })

  it('navigates the existing guest, clearing stale selection until the new document loads', async () => {
    const { controller, bridge, ready, event } = fixture()
    await controller.open()
    ready(`${baseUrl}/correo/MAIL-4?herald=1`)
    await controller.navigate('/seguimiento')
    expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith('mail-view-1', '/seguimiento')
    expect(controller.state.get()).toMatchObject({ phase: 'loading', selectedClave: null })
    event({ id: 'mail-view-1', type: 'url', url: `${baseUrl}/seguimiento?herald=1` })
    event({ id: 'mail-view-1', type: 'loading', loading: false })
    expect(controller.state.get()).toMatchObject({ phase: 'ready', selectedClave: null })
    expect(bridge.open).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('clears selection during guest-driven navigation and refuses a foreign-origin URL', async () => {
    const { controller, event, ready } = fixture()
    await controller.open()
    ready(`${baseUrl}/correo/MAIL-4?herald=1`)
    event({ id: 'mail-view-1', type: 'loading', loading: true })
    expect(controller.state.get().selectedClave).toBeNull()
    event({ id: 'mail-view-1', type: 'url', url: 'https://attacker.test/correo/MAIL-4' })
    event({ id: 'mail-view-1', type: 'loading', loading: false })
    expect(controller.state.get()).toMatchObject({ phase: 'error', selectedClave: null })
    controller.dispose()
  })

  it('reports a rejected navigation rather than claiming the requested view is open', async () => {
    const { controller, bridge, ready } = fixture()
    await controller.open()
    ready()
    vi.mocked(bridge.navigate).mockRejectedValue(new Error('Ruta no permitida.'))
    await controller.navigate('/not-allowed')
    expect(controller.state.get()).toMatchObject({ phase: 'error', selectedClave: null, error: 'Ruta no permitida.' })
    controller.dispose()
  })

  it('reloads the owned view without opening another or keeping stale context', async () => {
    const { controller, bridge, ready } = fixture()
    await controller.open()
    ready(`${baseUrl}/correo/MAIL-4?herald=1`)
    await controller.reload()
    expect(bridge.reload).toHaveBeenCalledExactlyOnceWith('mail-view-1')
    expect(bridge.open).toHaveBeenCalledTimes(1)
    expect(controller.state.get()).toMatchObject({ phase: 'loading', selectedClave: null })
    controller.dispose()
  })

  it('closes the owned guest and unsubscribes exactly once on disposal', async () => {
    const { controller, bridge, stop } = fixture()
    await controller.open()
    controller.dispose()
    controller.dispose()
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith('mail-view-1')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(controller.state.get()).toMatchObject({ phase: 'idle', viewId: null, selectedClave: null })
  })

  it('closes an opening that resolves after disposal instead of leaking a native view', async () => {
    const { controller, bridge } = fixture()
    const opening = deferred<{ id: string; baseUrl: string }>()
    vi.mocked(bridge.open).mockReturnValue(opening.promise)
    const wait = controller.open()
    controller.dispose()
    opening.resolve({ id: 'late-view', baseUrl })
    await wait
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith('late-view')
    expect(controller.state.get()).toMatchObject({ phase: 'idle', viewId: null })
  })

  it('can remount while an earlier open is still pending without adopting its late guest', async () => {
    const { controller, bridge, ready } = fixture()
    const old = deferred<{ id: string; baseUrl: string }>()
    vi.mocked(bridge.open).mockReturnValueOnce(old.promise)
    const previous = controller.open()
    controller.dispose()
    await controller.open('/lista')
    ready(`${baseUrl}/lista?herald=1`)
    old.resolve({ id: 'obsolete-view', baseUrl })
    await previous
    expect(bridge.close).toHaveBeenCalledWith('obsolete-view')
    expect(controller.state.get()).toMatchObject({ phase: 'ready', viewId: 'mail-view-1' })
    controller.dispose()
  })

  it('treats the guest closing as unavailable and permits a fresh explicit open', async () => {
    const { controller, bridge, event, ready } = fixture()
    await controller.open()
    ready()
    event({ id: 'mail-view-1', type: 'closed' })
    expect(controller.state.get()).toMatchObject({ phase: 'closed', viewId: null, selectedClave: null })
    await controller.open('/lista')
    expect(bridge.open).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
})
