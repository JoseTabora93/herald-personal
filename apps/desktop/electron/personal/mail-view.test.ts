import { describe, expect, it } from 'vitest'
import { mailViewUrl, mailViewAllows, personalPlanRequest } from './mail-view.ts'

describe('isolated mail navigation', () => {
  const origin = 'http://127.0.0.1:8097'
  it('keeps real mail routes and list navigation while entering embedded mode', () => {
    expect(mailViewUrl(origin, '/tablero')).toBe(`${origin}/tablero?herald=1`)
    expect(mailViewUrl(origin, '/correo/MAIL-52?de=lista&s=nav-1')).toBe(`${origin}/correo/MAIL-52?de=lista&s=nav-1&herald=1`)
    expect(mailViewAllows(origin, `${origin}/lista?estado=debo_respuesta`)).toBe(true)
    expect(mailViewAllows(origin, `${origin}/aprendizajes`)).toBe(true)
    expect(mailViewAllows(origin, `${origin}/lista?redactar=622c0315-019c-49c7-a1ba-2239dc407060`)).toBe(true)
    expect(mailViewAllows(origin, `${origin}/rezagados?umbral=180&anio=2025&remitente=fixture%40example.test`)).toBe(true)
  })
  it.each([
    '/correo/MAIL-0', '/correo/MAIL-1/../2', '/%74ablero', '//example.com/tablero',
    '/tablero?token=private', '/lista?q=a&q=b', '/lista?herald=0', '/home',
    '/_agent-native/actions/mail-send-confirm', '/lista#secret', '/lista?pagina=-1',
    '/lista?redactar=../../secret', '/rezagados?umbral=-1', '/rezagados?anio=no'
  ])('rejects route escalation: %s', route => expect(() => mailViewUrl(origin, route)).toThrow())
  it.each([
    'http://example.com', 'http://127.0.0.1:8097/path', 'https://user:pass@example.com',
    'file:///tmp/mail', 'http://localhost:8097?token=private'
  ])('rejects an unsafe configured origin: %s', target => expect(() => mailViewUrl(target, '/tablero')).toThrow())
  it('refuses redirects to another origin, credentials, APIs and unsupported protocols', () => {
    for (const url of ['https://example.com/tablero', 'http://localhost:8097/tablero', 'javascript:alert(1)', `${origin}/_agent-native`, 'http://user@127.0.0.1:8097/tablero']) {
      expect(mailViewAllows(origin, url)).toBe(false)
    }
  })
})

describe('scheduled local opening', () => {
  it('accepts only an actual ISO day from the explicit plan flag', () => {
    expect(personalPlanRequest(['Herald', '--personal-plan', '2026-10-08'])).toEqual({ date: '2026-10-08' })
    expect(personalPlanRequest(['Herald'])).toBeNull()
    expect(personalPlanRequest(['Herald', '--personal-plan', '2026-02-30'])).toBeNull()
    expect(personalPlanRequest(['Herald', '--personal-plan', '--execute=rm'])).toBeNull()
    expect(personalPlanRequest(['Herald', '--personal-plan', '2026-10-08', '--personal-plan', '2026-10-09'])).toBeNull()
  })
})
