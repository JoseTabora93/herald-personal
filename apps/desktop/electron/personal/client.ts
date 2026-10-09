import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { PersonalRequest } from '../../shared/personal.ts'

type Environment = Record<string, string | undefined>

/** A packaged app launched from Finder has no shell environment. Load only a private pointer. */
export async function personalEnvironment(file: string, env: Environment = process.env): Promise<Environment> {
  if (env.HERALD_PERSONAL_TOKEN || env.HERALD_PERSONAL_TOKEN_FILE) return env
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > 16_384 || (process.platform !== 'win32' &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error('La configuración personal debe ser privada.')
    }
    const config: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!config || typeof config !== 'object' || !('url' in config) || !('tokenFile' in config) ||
        typeof config.url !== 'string' || typeof config.tokenFile !== 'string' || !isAbsolute(config.tokenFile)) {
      throw new Error('La configuración personal privada no es válida.')
    }
    const result = { ...env, HERALD_PERSONAL_URL: config.url, HERALD_PERSONAL_TOKEN_FILE: config.tokenFile }
    serviceOrigin(result)
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return env
    throw new Error('No se pudo leer la configuración privada del servicio personal.')
  }
}

const maxRequestBytes = 256 * 1024
const maxResponseBytes = 2 * 1024 * 1024
const id = '[A-Za-z0-9_-]{1,128}'
const routes: [string, RegExp, string[]][] = [
  ['GET', /^\/v1\/(status|overview)$/, []],
  ['GET', /^\/v1\/(mail-workspace\/status|agent-observations)$/, []],
  ['GET', /^\/v1\/daily-plans$/, ['date']],
  ['POST', /^\/v1\/daily-plans\/generate$/, []],
  ['POST', /^\/v1\/mail-workspace\/(query|tasks|local)$/, []],
  ['GET', /^\/v1\/brief$/, ['kind']],
  ['GET', /^\/v1\/tasks$/, ['status', 'q']],
  ['POST', /^\/v1\/tasks$/, []],
  ['GET', new RegExp(`^/v1/tasks/${id}(/events)?$`), []],
  ['PATCH', new RegExp(`^/v1/tasks/${id}$`), []],
  ['GET', /^\/v1\/mail\/threads$/, ['q', 'category', 'limit', 'offset']],
  ['POST', /^\/v1\/mail\/sync$/, []],
  ['PATCH', new RegExp(`^/v1/mail/threads/${id}$`), []],
  ['POST', new RegExp(`^/v1/mail/threads/${id}/(task|draft|archive)$`), []],
  ['POST', new RegExp(`^/v1/mail/actions/${id}/undo$`), []],
  ['GET', /^\/v1\/(checkins|agent-runs)$/, []],
  ['PUT', /^\/v1\/checkins\/\d{4}-\d{2}-\d{2}$/, []]
]

function validateRequest(request: PersonalRequest): string | undefined {
  if (!request || typeof request.path !== 'string' || request.path.length > 2048 ||
      !request.path.startsWith('/v1/') || /[#\\\s]/.test(request.path)) {
    throw new Error('Solicitud personal no permitida.')
  }
  // Validate the literal path before URL normalization can erase traversal segments.
  const [path, query = ''] = request.path.split('?')
  if (request.path.split('?').length > 2) throw new Error('Solicitud personal no permitida.')
  const route = routes.find(([method, pattern]) => method === request.method && pattern.test(path))
  if (!route) throw new Error('Solicitud personal no permitida.')
  const params = new URLSearchParams(query)
  const seen = new Set<string>()
  for (const [key, value] of params) {
    if (!route[2].includes(key) || seen.has(key) || value.length > 500 || /[\x00-\x1f]/.test(value)) {
      throw new Error('Solicitud personal no permitida.')
    }
    if ((key === 'limit' || key === 'offset') && (!/^\d+$/.test(value) ||
        Number(value) < (key === 'limit' ? 1 : 0) || Number(value) > (key === 'limit' ? 50 : 100000))) {
      throw new Error('Solicitud personal no permitida.')
    }
    seen.add(key)
  }
  if (request.method === 'GET' && request.body !== undefined) throw new Error('Solicitud personal no permitida.')
  if (request.body === undefined) return undefined
  let body: string
  try { body = JSON.stringify(request.body) } catch { throw new Error('Solicitud personal no permitida.') }
  if (typeof body !== 'string') throw new Error('Solicitud personal no permitida.')
  if (Buffer.byteLength(body) > maxRequestBytes) throw new Error('La solicitud personal es demasiado grande.')
  return body
}

function serviceOrigin(env: Environment): string {
  try {
    const url = new URL(env.HERALD_PERSONAL_URL || 'http://127.0.0.1:8787')
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error()
    return url.origin
  } catch { throw new Error('La dirección del servicio personal debe ser HTTPS o una dirección local.') }
}

async function serviceToken(env: Environment): Promise<string> {
  let token = env.HERALD_PERSONAL_TOKEN?.trim()
  if (!token && env.HERALD_PERSONAL_TOKEN_FILE) {
    try {
      const file = env.HERALD_PERSONAL_TOKEN_FILE
      if (!isAbsolute(file)) throw new Error()
      const info = await stat(file)
      if (!info.isFile() || info.size > 8192 ||
          (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error()
      token = (await readFile(file, 'utf8')).trim()
    } catch { throw new Error('No se pudo leer la credencial privada del servicio personal.') }
  }
  if (!token || /[\r\n]/.test(token) || token.length > 8192) {
    throw new Error('Configura la credencial del servicio personal para conectar Herald.')
  }
  return token
}

function statusError(status: number): Error {
  const messages: Record<number, string> = {
    401: 'La credencial del servicio personal no es válida.',
    403: 'Esta operación no está habilitada.',
    404: 'El registro ya no está disponible.',
    409: 'El registro cambió o la operación ya existe. Actualiza antes de continuar.',
    422: 'Revisa los datos de la solicitud.',
    429: 'El servicio está ocupado. Intenta más tarde.',
    502: 'El proveedor no respondió correctamente. El resultado debe verificarse antes de repetir una escritura.',
    503: 'El servicio o proveedor todavía no está disponible.'
  }
  return new Error(`${status}: ${messages[status] || 'No se pudo completar la operación personal.'}`)
}

/** Sole credential-bearing transport. Never retries writes or forwards upstream diagnostics. */
export async function requestPersonal<T = unknown>(
  request: PersonalRequest,
  env: Environment = process.env,
  fetcher: typeof fetch = fetch
): Promise<T> {
  const body = validateRequest(request)
  const origin = serviceOrigin(env)
  const token = await serviceToken(env)
  let response: Response
  try {
    response = await fetcher(`${origin}${request.path}`, {
      method: request.method, body, redirect: 'error', signal: AbortSignal.timeout(request.path === '/v1/mail-workspace/local' ? 135_000 : 20_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }
    })
  } catch { throw new Error('Servicio personal desconectado o sin respuesta. Verifica su estado antes de repetir una escritura.') }
  if (!response.ok) { await response.body?.cancel(); throw statusError(response.status) }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel()
    throw new Error('El servicio personal devolvió una respuesta no válida.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('El servicio personal devolvió una respuesta vacía.')
  const parts: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maxResponseBytes) {
        await reader.cancel()
        throw new Error('La respuesta personal es demasiado grande.')
      }
      parts.push(chunk.value)
    }
  } catch (error) {
    if (length > maxResponseBytes) throw error
    throw new Error('La respuesta personal quedó incompleta. Actualiza antes de continuar.')
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as T }
  catch { throw new Error('El servicio personal devolvió una respuesta no válida.') }
}
