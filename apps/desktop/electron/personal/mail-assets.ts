import type { PersonalMailAsset } from '../../shared/personal.ts'
import { serviceOrigin, serviceToken } from './client.ts'

export interface MailFile { bytes: Buffer; mime: string; name: string }
const maximum = 20 * 1024 * 1024
const id = /^[A-Za-z0-9_+/=-]{1,2048}$/
export function validateMailAsset(value: PersonalMailAsset): void {
  if (!value || typeof value !== 'object' || !['signature', 'attachment'].includes(value.kind) ||
      Object.keys(value).some(key => !['kind', 'clave', 'message_id', 'attachment_id'].includes(key)) ||
      (value.kind === 'signature' ? Object.keys(value).length !== 1 : typeof value.clave !== 'string' || typeof value.message_id !== 'string' || typeof value.attachment_id !== 'string' || !/^MAIL-[1-9][0-9]{0,9}$/.test(value.clave) || !id.test(value.message_id) || !id.test(value.attachment_id))) {
    throw new Error('Referencia de correo inválida.')
  }
}
export async function readMailAsset(ref: PersonalMailAsset, env = process.env, fetcher: typeof fetch = fetch): Promise<MailFile> {
  validateMailAsset(ref)
  const origin = serviceOrigin(env), token = await serviceToken(env)
  let response: Response
  try { response = await fetcher(origin + '/v1/mail-workspace/asset', { method: 'POST', body: JSON.stringify(ref), redirect: 'error', signal: AbortSignal.timeout(65_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }) }
  catch { throw new Error('No se pudo descargar el archivo. Revisa la conexión de correo.') }
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 404 ? 'La imagen o firma ya no está disponible.' : 'No se pudo descargar el archivo de correo.') }
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('El archivo supera el límite de 20 MB.') }
  const reader = response.body?.getReader(), parts: Uint8Array[] = []; let length = 0
  if (!reader) throw new Error('Archivo vacío.')
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break
      length += chunk.value.length
      if (length > maximum) throw new Error('El archivo supera el límite de 20 MB.')
      parts.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  if (!length) throw new Error('Archivo vacío.')
  let name = 'adjunto'
  try { name = safeMailFilename(decodeURIComponent(response.headers.get('x-mail-filename') || name)) } catch { /* use default */ }
  return { bytes: Buffer.concat(parts), mime: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream', name }
}
export function safeMailFilename(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop()?.replace(/[\x00-\x1f\x7f:]/g, '').replace(/^\.+/, '').slice(0, 180) || 'adjunto'
}
export function previewMailAsset(file: MailFile): string {
  const b = file.bytes
  const signatures: Record<string, boolean> = {
    'image/png': b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    'image/jpeg': b[0] === 255 && b[1] === 216 && b[2] === 255,
    'image/gif': ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString()),
    'image/webp': b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'
  }
  if (b.length > 6 * 1024 * 1024 || !signatures[file.mime]) throw new Error('Vista previa no disponible: descarga el archivo para abrirlo.')
  return `data:${file.mime};base64,${b.toString('base64')}`
}
export async function saveMailAsset(ref: PersonalMailAsset, suggestedName: string, choose: (name: string) => Promise<string | undefined>, read: (ref: PersonalMailAsset) => Promise<MailFile>, write: (path: string, bytes: Buffer) => Promise<unknown>): Promise<{ cancelled: boolean }> {
  validateMailAsset(ref)
  const target = await choose(safeMailFilename(suggestedName))
  if (!target) return { cancelled: true }
  const file = await read(ref)
  await write(target, file.bytes)
  return { cancelled: false }
}
