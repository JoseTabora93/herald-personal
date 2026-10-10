import { atom } from 'nanostores'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../lib/rest.ts', () => ({ rest: {} }))
vi.mock('../../store/gateway.ts', () => ({ $gatewayReady: atom(false), onGatewayEvent: vi.fn() }))
vi.mock('../../store/notifications.ts', () => ({ notify: vi.fn() }))
vi.mock('../../store/shell.ts', () => ({ isMainSurface: true, isPanels: false }))
vi.mock('../../store/os-commands.ts', () => ({ runCommand: vi.fn() }))
vi.mock('../../store/windows.ts', () => ({ desktopArea: vi.fn(), showPage: vi.fn() }))
vi.mock('../../store/web-windows.ts', () => ({ $webWindows: atom({}), closeWebWindow: vi.fn(), focusWebWindow: vi.fn(), openWebWindow: vi.fn() }))
import { $hermesAuth } from '../../store/hermes-auth.ts'
import { HermesLoginCard } from './HermesLoginCard.tsx'

beforeEach(() => {
  $hermesAuth.set({ checked: true, activeProvider: null, providers: [{ id: 'nous', name: 'Nous Portal', flow: 'device_code', cliCommand: null, docsUrl: null, loggedIn: false, source: null }], needsLogin: true, reason: 'No AI provider. Try Nous Portal login. Config: /private/qa-hermes-home/.env', snoozed: false })
})
it('offers model settings without promoting Nous or exposing runtime paths for missing configuration', () => {
  const html = renderToStaticMarkup(createElement(HermesLoginCard))
  expect(html).toContain('Configura el modelo de Hermes')
  expect(html).toContain('Elegir proveedor en Ajustes')
  expect(html).not.toContain('Nous Portal')
  expect(html).not.toContain('/private/qa-hermes-home')
})
it('does not show a provider invitation when dismissed or on a quiet startup', () => {
  $hermesAuth.set({ ...$hermesAuth.get(), needsLogin: false })
  expect(renderToStaticMarkup(createElement(HermesLoginCard))).toBe('')
})
it('keeps explicit sign-in available for the provider the user selected', () => {
  $hermesAuth.set({ ...$hermesAuth.get(), activeProvider: 'nous', reason: null })
  expect(renderToStaticMarkup(createElement(HermesLoginCard))).toContain('Sign in with Nous Portal')
})
