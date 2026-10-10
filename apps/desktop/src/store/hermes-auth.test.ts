import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn(), event: vi.fn(), notify: vi.fn() }))
vi.mock('../lib/rest.ts', () => ({ rest: { get: io.get, post: io.post, del: io.del } }))
vi.mock('./gateway.ts', () => ({ $gatewayReady: atom(false), onGatewayEvent: io.event }))
vi.mock('./notifications.ts', () => ({ notify: io.notify }))
vi.mock('./shell.ts', () => ({ isMainSurface: true }))
import { $hermesAuth, bindHermesAuth, loginTarget, refreshHermesAuth, requestHermesLogin, snoozeHermesLogin } from './hermes-auth.ts'

const providers = [
  { id: 'nous', name: 'Nous Portal', flow: 'device_code', status: { logged_in: false } },
  { id: 'openai-codex', name: 'ChatGPT', flow: 'device_code', status: { logged_in: true } }
]
function configure(provider: string | null) {
  io.get.mockImplementation(async (route: string) => route === '/api/providers/oauth'
    ? { providers }
    : { yaml: provider ? `model:\n  provider: ${provider}\n` : 'model:\n  default: example\n' })
}
beforeEach(() => {
  vi.resetAllMocks()
  io.event.mockReturnValue(() => undefined)
  $hermesAuth.set({ checked: false, activeProvider: null, providers: [], needsLogin: false, reason: null, snoozed: false })
})

describe('provider-neutral startup', () => {
  it('does not open a login invitation on startup even for a signed-out provider', async () => {
    configure('nous')
    expect(await refreshHermesAuth()).toMatchObject({ checked: true, activeProvider: 'nous', needsLogin: false, reason: null })
  })
  it.each([null, 'auto', 'zai', 'unlisted'])('never substitutes Nous for provider %s', async provider => {
    configure(provider)
    await refreshHermesAuth()
    expect(loginTarget()).toBeNull()
  })
  it('uses a provider only when it is explicitly configured', async () => {
    configure('openai-codex')
    await refreshHermesAuth()
    expect(loginTarget()).toMatchObject({ id: 'openai-codex', loggedIn: true })
  })
  it('forgets the old provider when configuration no longer selects it', async () => {
    configure('nous'); await refreshHermesAuth()
    configure(null); await refreshHermesAuth()
    expect(loginTarget()).toBeNull()
    expect($hermesAuth.get().activeProvider).toBeNull()
  })
  it('keeps a requested setup prompt visible when no OAuth provider is selected', async () => {
    configure(null)
    requestHermesLogin('Hermes is not connected to any AI provider yet.')
    await refreshHermesAuth()
    expect($hermesAuth.get().needsLogin).toBe(true)
    expect(loginTarget()).toBeNull()
  })
  it('preserves explicit sign-in, dismissal and a new failed turn', async () => {
    configure('nous'); await refreshHermesAuth()
    requestHermesLogin('No access token')
    expect((await refreshHermesAuth()).needsLogin).toBe(true)
    snoozeHermesLogin()
    expect((await refreshHermesAuth()).needsLogin).toBe(false)
    requestHermesLogin('No access token')
    expect($hermesAuth.get()).toMatchObject({ needsLogin: true, snoozed: false })
  })
  it('closes a requested prompt when the active account becomes connected', async () => {
    configure('openai-codex'); requestHermesLogin('Expired login')
    expect(await refreshHermesAuth()).toMatchObject({ needsLogin: false, reason: null })
  })
  it('still offers recovery for authentication failures from chat', () => {
    const off = bindHermesAuth()
    const listener = io.event.mock.calls.find(([name]) => name === 'error')![1]
    listener({ payload: { message: '401 Unauthorized' } })
    expect($hermesAuth.get().needsLogin).toBe(true)
    off()
  })
})
