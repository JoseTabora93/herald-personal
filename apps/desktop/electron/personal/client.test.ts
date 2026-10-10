import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { personalEnvironment, requestPersonal } from './client.ts'

const env = { HERALD_PERSONAL_URL: 'http://127.0.0.1:8787', HERALD_PERSONAL_TOKEN: 'private-test-credential' }
const get = { method: 'GET' as const, path: '/v1/status' }
const response = () => new Response(JSON.stringify({ version: '1' }), { headers: { 'content-type': 'application/json' } })

describe('installed personal connection', () => {
  it('loads only a private connection pointer and never exposes the token value', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'herald-connection-'))
    try {
      const config = path.join(dir, 'connection.json')
      await writeFile(config, JSON.stringify({ url: 'http://127.0.0.1:8787', tokenFile: path.join(dir, 'token') }), { mode: 0o600 })
      expect(await personalEnvironment(config, {})).toEqual({ HERALD_PERSONAL_URL: 'http://127.0.0.1:8787', HERALD_PERSONAL_TOKEN_FILE: path.join(dir, 'token') })
      expect(await personalEnvironment(config, env)).toEqual(env)
      await chmod(config, 0o644)
      await expect(personalEnvironment(config, {})).rejects.toThrow(/privad/i)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('keeps a missing installation unconfigured', async () => {
    expect(await personalEnvironment('/nonexistent-herald/connection.json', {})).toEqual({})
  })
})

describe('personal service credential boundary', () => {
  it('allows project chat reads and links while rejecting direction writes from the renderer', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response())
    const base = `/v1/projects/${'a'.repeat(24)}`
    await requestPersonal({ method: 'GET', path: `${base}/workspace` }, env, fetcher)
    await requestPersonal({ method: 'POST', path: `${base}/conversations`, body: { session_id: 'qa', title: 'QA' } }, env, fetcher)
    await expect(requestPersonal({ method: 'PUT', path: `${base}/direction`, body: {} }, env, fetcher)).rejects.toThrow(/solicitud/i)
    await expect(requestPersonal({ method: 'GET', path: `${base}/workspace?token=unsafe` }, env, fetcher)).rejects.toThrow(/solicitud/i)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('fails closed without credentials and never calls the service', async () => {
    const fetcher = vi.fn()
    await expect(requestPersonal(get, {}, fetcher)).rejects.toThrow(/configur/i)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('adds credentials in main, rejects redirects and returns only service JSON', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response())
    expect(await requestPersonal(get, env, fetcher)).toEqual({ version: '1' })
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8787/v1/status')
    expect(options.redirect).toBe('error')
    expect(options.headers).toMatchObject({ Authorization: 'Bearer private-test-credential' })
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it.each(['https://evil.test/v1/status', '//evil.test/v1/status', '/v1/../admin', '/v1/tasks/%2e%2e', '/v1/tasks/a%2fb', '/v1/status#fragment', '/v1/status?token=x', '/v1/mail/threads/a/send'])('rejects unsafe or unsupported path %s before fetch', async path => {
    const fetcher = vi.fn()
    await expect(requestPersonal({ ...get, path }, env, fetcher)).rejects.toThrow(/solicitud/i)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['http://example.com', 'https://user:secret@example.com', 'https://example.com/base', 'https://example.com/?token=x'])('rejects unsafe configured origin %s', async origin => {
    await expect(requestPersonal(get, { ...env, HERALD_PERSONAL_URL: origin }, vi.fn())).rejects.toThrow(/dirección/i)
  })

  it('allows an HTTPS remote service and valid bounded search', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response())
    await requestPersonal({ ...get, path: '/v1/mail/threads?q=compras%20BAC&category=action' }, { ...env, HERALD_PERSONAL_URL: 'https://personal.example.com/' }, fetcher)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://personal.example.com/v1/mail/threads?q=compras%20BAC&category=action')
  })

  it('allows bounded pagination and rejects malformed page requests before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response())
    await requestPersonal({ ...get, path: '/v1/mail/threads?offset=50&limit=25' }, env, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    for (const query of ['limit=0', 'limit=51', 'offset=-1', 'offset=100001', 'offset=1.5', 'offset=abc', 'offset=0&offset=5']) {
      await expect(requestPersonal({ ...get, path: `/v1/mail/threads?${query}` }, env, fetcher)).rejects.toThrow(/solicitud/i)
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not forward server bodies or network details containing secrets', async () => {
    await expect(requestPersonal(get, env, async () => new Response('private-test-credential traceback', { status: 409 }))).rejects.toThrow(/^409: /)
    await expect(requestPersonal(get, env, async () => { throw new Error('private-test-credential') })).rejects.not.toThrow(/private-test-credential/)
  })

  it('refuses unsupported methods, GET bodies and oversized writes', async () => {
    const fetcher = vi.fn()
    await expect(requestPersonal({ method: 'DELETE', path: '/v1/tasks/a' } as never, env, fetcher)).rejects.toThrow(/solicitud/i)
    await expect(requestPersonal({ ...get, body: {} }, env, fetcher)).rejects.toThrow(/solicitud/i)
    await expect(requestPersonal({ method: 'POST', path: '/v1/tasks', body: { title: 'x'.repeat(270000) } }, env, fetcher)).rejects.toThrow(/grande/i)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('bounds service responses and refuses non-JSON', async () => {
    await expect(requestPersonal(get, env, async () => new Response('x'.repeat(2100000), { headers: { 'content-type': 'application/json' } }))).rejects.toThrow(/grande/i)
    await expect(requestPersonal(get, env, async () => new Response('<html>not data</html>'))).rejects.toThrow(/respuesta/i)
  })
})
