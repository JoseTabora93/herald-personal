import { atom } from 'nanostores'
import type { WebViewEvent } from '../../../shared/ipc.ts'
import { errorMessage } from './model.ts'

export const MAIL_WORKSPACE_VIEWS = { tablero: 'Tablero', lista: 'Lista', seguimiento: 'Seguimiento', aprendizajes: 'Aprendizajes', limpieza: 'Limpieza', rezagados: 'Rezagados', historico: 'Histórico' } as const
export type MailWorkspacePhase = 'idle' | 'opening' | 'loading' | 'ready' | 'error' | 'closed'
export interface MailWorkspaceState {
  phase: MailWorkspacePhase
  viewId: string | null
  baseUrl: string | null
  url: string | null
  selectedClave: string | null
  error: string | null
}
export interface MailWorkspaceBridge {
  open: (route: string) => Promise<{ id: string; baseUrl: string }>
  navigate: (id: string, route: string) => Promise<void>
  reload: (id: string) => Promise<void>
  close: (id: string) => Promise<void>
  onEvent: (listener: (event: WebViewEvent) => void) => () => void
}

function trustedUrl(raw: string, baseUrl: string): URL | null {
  try {
    const url = new URL(raw)
    const base = new URL(baseUrl)
    return /^https?:$/.test(url.protocol) && url.origin === base.origin && !url.username && !url.password ? url : null
  } catch { return null }
}

/** Only the stable thread key crosses from a guest document into Hermes or a commitment. */
export function parseMailSelection(raw: string, baseUrl: string): string | null {
  return trustedUrl(raw, baseUrl)?.pathname.match(/^\/correo\/(MAIL-[1-9][0-9]*)$/)?.[1] ?? null
}

export function mailEditorIsOpen(state: MailWorkspaceState): boolean {
  return state.phase === 'ready' && Boolean(state.url && state.baseUrl && trustedUrl(state.url, state.baseUrl)?.searchParams.get('redactar'))
}

const emptyState = (): MailWorkspaceState => ({ phase: 'idle', viewId: null, baseUrl: null, url: null, selectedClave: null, error: null })

/** Owns one isolated guest. Keeping the panel mounted preserves its editor and navigation state. */
export function createMailWorkspaceController(bridge: MailWorkspaceBridge) {
  const state = atom<MailWorkspaceState>(emptyState())
  const patch = (value: Partial<MailWorkspaceState>) => state.set({ ...state.get(), ...value })
  let generation = 0
  let pending: Promise<void> | null = null
  let unsubscribe: (() => void) | null = null
  let buffered: WebViewEvent[] = []
  let documentLoaded = false
  let route = '/tablero'

  function fail(error: unknown) {
    patch({ phase: 'error', selectedClave: null, error: errorMessage(error) })
  }

  function loaded() {
    const current = state.get()
    if (documentLoaded && current.url && current.baseUrl && current.phase !== 'error') {
      patch({ phase: 'ready', error: null, selectedClave: parseMailSelection(current.url, current.baseUrl) })
    }
  }

  function receive(event: WebViewEvent) {
    const current = state.get()
    if (!current.viewId) {
      if (current.phase === 'opening' && event.type !== 'title') buffered = [...buffered.slice(-63), event]
      return
    }
    if (event.id !== current.viewId) return
    switch (event.type) {
      case 'url': {
        if (!current.baseUrl || !trustedUrl(event.url, current.baseUrl)) {
          fail(new Error('La página de correo salió del origen configurado. Vuelve a abrir una vista de correo.'))
          return
        }
        patch({ url: event.url, selectedClave: null })
        loaded()
        return
      }
      case 'loading':
        documentLoaded = !event.loading
        if (event.loading) patch({ phase: 'loading', selectedClave: null, url: null, error: null })
        else loaded()
        return
      case 'error': fail(new Error(event.error)); return
      case 'closed':
        documentLoaded = false
        patch({ phase: 'closed', viewId: null, url: null, selectedClave: null, error: null })
        return
      default: return
    }
  }

  function open(target = '/tablero'): Promise<void> {
    if (pending) return pending
    if (state.get().viewId) return Promise.resolve()
    const current = ++generation
    route = target
    documentLoaded = false
    buffered = []
    patch({ phase: 'opening', selectedClave: null, url: null, error: null })
    pending = (async () => {
      try {
        unsubscribe ??= bridge.onEvent(receive)
        const result = await bridge.open(target)
        if (current !== generation) {
          await bridge.close(result.id).catch(() => undefined)
          return
        }
        patch({ viewId: result.id, baseUrl: result.baseUrl, phase: 'loading' })
        const events = buffered
        buffered = []
        events.forEach(receive)
      } catch (error) {
        if (current === generation) fail(error)
      } finally {
        if (current === generation) pending = null
      }
    })()
    return pending
  }

  async function navigate(target: string) {
    const wasOpening = Boolean(pending)
    if (pending) await pending
    if (!state.get().viewId) return open(target)
    if (wasOpening && route === target) return
    if (mailEditorIsOpen(state.get())) throw new Error('Cierra el editor de correo antes de cambiar de vista o recargar.')
    route = target
    documentLoaded = false
    patch({ phase: 'loading', selectedClave: null, url: null, error: null })
    const current = generation
    try { await bridge.navigate(state.get().viewId!, target) }
    catch (error) { if (current === generation) fail(error) }
  }

  async function reload() {
    if (pending) await pending
    const id = state.get().viewId
    if (!id) return open(route)
    if (mailEditorIsOpen(state.get())) throw new Error('Cierra el editor de correo antes de cambiar de vista o recargar.')
    documentLoaded = false
    patch({ phase: 'loading', selectedClave: null, url: null, error: null })
    const current = generation
    try { await bridge.reload(id) }
    catch (error) { if (current === generation) fail(error) }
  }

  function dispose() {
    ++generation
    const id = state.get().viewId
    pending = null
    buffered = []
    documentLoaded = false
    unsubscribe?.()
    unsubscribe = null
    state.set(emptyState())
    if (id) void bridge.close(id).catch(() => undefined)
  }

  return { state, open, navigate, reload, dispose }
}
