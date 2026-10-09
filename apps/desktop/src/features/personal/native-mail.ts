import { atom } from 'nanostores'
import type { PersonalRequest } from '../../../shared/personal.ts'
import { errorMessage } from './model.ts'
import { MAIL_WORKSPACE_VIEWS } from './mail-workspace.ts'

export type MailView = keyof typeof MAIL_WORKSPACE_VIEWS
export type JsonRecord = Record<string, unknown>
export const MAIL_STATES = { por_clasificar: 'Por clasificar', debo_respuesta: 'Debo responder', para_enterarme: 'Para enterarme', esperando_respuesta: 'Esperando respuesta', agendado: 'Agendado', hecho: 'Hecho' } as const
export const MAIL_CATEGORIES = ['Clientes', 'Proveedores', 'Licitaciones', 'Interno', 'Notificaciones', 'Ruido']
export const MAIL_PRIORITIES = { alta: 'Alta', media: 'Media', baja: 'Baja' }
export interface MailItem extends JsonRecord { clave: string; asunto: string; estado: string; prioridad?: string; categoria?: string; ultimoRemitente: { nombre: string; direccion: string }; ultimoMensajeEn: string }
export interface MailThread { item: MailItem; mensajes: JsonRecord[]; totalMensajes: number }
export interface MailRecipient { nombre: string; direccion: string }
export interface MailCompose extends JsonRecord { id: string; clave: string | null; modo: string; asunto: string; para: MailRecipient[]; cc: MailRecipient[]; cco: MailRecipient[]; cuerpoMd: string; incluirFirma: boolean; adjuntos: JsonRecord[]; estado: string; version: number }
export interface MailFilters { texto: string; estado: string; categoria: string; prioridad: string; carpeta: string; periodo: string; orden: string; noLeido: boolean; jevDuda: boolean; desplazamiento: number }
export interface NativeMailState {
  view: MailView; legacy: boolean; phase: 'idle' | 'loading' | 'ready' | 'error'; error: string | null
  filters: MailFilters; items: MailItem[]; total: number; counts: JsonRecord | null; folders: JsonRecord[]; auxiliary: JsonRecord | null; supplemental: JsonRecord | null; supplementalError: string | null
  selectedClave: string | null; thread: MailThread | null; detailLoading: boolean; detailError: string | null; messageLimit: number
  compose: MailCompose | null; dirty: boolean; busy: boolean; draft: JsonRecord | null; composerError: string | null
}
const keyPattern = /^MAIL-[1-9][0-9]{0,9}$/
const localIdPattern = /^[A-Za-z0-9_-]{1,128}$/
export function record(raw: unknown): JsonRecord { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('El servicio devolvió datos de correo inválidos.'); return raw as JsonRecord }
export function textValue(raw: unknown): string { return typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '' }
export function records(raw: unknown): JsonRecord[] { return Array.isArray(raw) ? raw.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [] }
export function parseMailItem(raw: unknown): MailItem {
  const value = record(raw)
  if (typeof value.clave !== 'string' || !keyPattern.test(value.clave) || typeof value.asunto !== 'string' || typeof value.estado !== 'string') throw new Error('El hilo de correo no tiene una identidad válida.')
  return { ...value, ultimoRemitente: { nombre: '', direccion: '', ...record(value.ultimoRemitente ?? {}) }, ultimoMensajeEn: textValue(value.ultimoMensajeEn) } as MailItem
}
export function parseMailPage(raw: unknown) {
  const value = record(raw)
  if (!Number.isSafeInteger(value.total) || Number(value.total) < 0 || !Array.isArray(value.items)) throw new Error('La lista de correo llegó incompleta. Reintenta la consulta.')
  return { items: value.items.map(parseMailItem), total: Number(value.total) }
}
function parseCompose(raw: unknown): MailCompose {
  const value = record(raw)
  if (typeof value.id !== 'string' || !localIdPattern.test(value.id) || typeof value.cuerpoMd !== 'string' || typeof value.asunto !== 'string' || !Array.isArray(value.para) || !Array.isArray(value.cc) || !Array.isArray(value.cco) || !Number.isSafeInteger(value.version) || (value.clave != null && !keyPattern.test(String(value.clave)))) throw new Error('El servicio no confirmó el borrador de redacción.')
  return value as MailCompose
}
export function recipientsText(list: MailRecipient[]): string { return list.map(x => x.nombre ? `${x.nombre} <${x.direccion}>` : x.direccion).join('; ') }
export function parseRecipients(input: string): MailRecipient[] {
  const list = input.split(/[;,\n]/).map(x => x.trim()).filter(Boolean).map(value => {
    const match = value.match(/^(.*?)<([^<>]+)>$/)
    const direccion = (match ? match[2] : value).trim()
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(direccion)) throw new Error(`Revisa la dirección: ${direccion.slice(0, 80)}`)
    return { nombre: match ? match[1].trim() : '', direccion }
  })
  if (list.length > 100) throw new Error('Usa un máximo de 100 destinatarios por campo.')
  return list
}

export function createNativeMailController(request: (request: PersonalRequest) => Promise<unknown>, storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const state = atom<NativeMailState>({ view: 'tablero', legacy: false, phase: 'idle', error: null, filters: { texto: '', estado: '', categoria: '', prioridad: '', carpeta: '', periodo: 'ventana', orden: 'recientes', noLeido: false, jevDuda: false, desplazamiento: 0 }, items: [], total: 0, counts: null, folders: [], auxiliary: null, supplemental: null, supplementalError: null, selectedClave: null, thread: null, detailLoading: false, detailError: null, messageLimit: 10, compose: null, dirty: false, busy: false, draft: null, composerError: null })
  const patch = (value: Partial<NativeMailState>) => state.set({ ...state.get(), ...value })
  const query = (action: string, params: JsonRecord = {}, local = false) => request({ method: 'POST', path: `/v1/mail-workspace/${local ? 'local' : 'query'}`, body: { action, params } })
  let listGeneration = 0; let detailGeneration = 0; let editRevision = 0; let restoreAttempted = false
  const pointerKey = 'herald.personal.mail.compose.v1'
  const remember = (id: string | null) => { try { if (id) storage?.setItem(pointerKey, id); else storage?.removeItem(pointerKey) } catch { /* Memory editing remains available when storage is disabled. */ } }
  async function load() {
    const generation = ++listGeneration
    const { view, filters } = state.get()
    patch({ phase: 'loading', error: null, items: [], total: 0, auxiliary: null, supplemental: null, supplementalError: null })
    const params: JsonRecord = { periodo: filters.periodo, orden: filters.orden, limite: 25, desplazamiento: filters.desplazamiento }
    for (const field of ['texto', 'estado', 'categoria', 'prioridad', 'carpeta', 'noLeido', 'jevDuda'] as const) if (filters[field]) params[field] = filters[field]
    if (view === 'seguimiento' && !filters.estado) params.estado = ['debo_respuesta', 'esperando_respuesta', 'agendado']
    if (view === 'historico') params.periodo = 'todo'
    try {
      let result: unknown
      if (view === 'aprendizajes') result = await query('mail-aprendizajes-listar')
      else if (view === 'limpieza') result = await query('mail-limpieza-propuestas', { limite: 25, desplazamiento: filters.desplazamiento, ...(filters.carpeta ? { carpeta: filters.carpeta } : {}) })
      else if (view === 'rezagados') result = await query('mail-rezagados', { limite: 25, desplazamiento: filters.desplazamiento, ...(filters.carpeta ? { carpeta: filters.carpeta } : {}) })
      else result = await query('mail-list-items', params)
      if (generation !== listGeneration) return
      if (view === 'aprendizajes' || view === 'limpieza') {
        const auxiliary = record(result)
        if (!Array.isArray(auxiliary[view === 'aprendizajes' ? 'aprendizajes' : 'grupos'])) throw new Error('El resumen de correo llegó incompleto.')
        patch({ phase: 'ready', auxiliary })
      }
      else patch({ ...parseMailPage(result), phase: 'ready' })
      if (view === 'historico' || view === 'limpieza') {
        void query(view === 'historico' ? 'mail-backfill-estado' : 'mail-lotes-estado')
          .then(value => { if (generation === listGeneration) patch({ supplemental: record(value) }) })
          .catch(() => { if (generation === listGeneration) patch({ supplementalError: 'No se pudo consultar el progreso. Reintenta actualizar.' }) })
      }
    } catch (error) { if (generation === listGeneration) patch({ phase: 'error', error: errorMessage(error) }) }
  }
  async function overview() {
    const results = await Promise.allSettled([query('mail-counts'), query('mail-carpetas')])
    if (results[0].status === 'fulfilled') patch({ counts: record(results[0].value) })
    if (results[1].status === 'fulfilled') patch({ folders: records(record(results[1].value).carpetas) })
  }
  async function filter(value: Partial<MailFilters>) { patch({ filters: { ...state.get().filters, desplazamiento: 0, ...value } }); await load() }
  async function navigate(view: MailView) {
    if (!(view in MAIL_WORKSPACE_VIEWS)) throw new Error('Vista de correo desconocida.')
    patch({ view, legacy: false, filters: { ...state.get().filters, desplazamiento: 0, estado: '', texto: '' } })
    await load()
  }
  async function select(clave: string, messageLimit = 10) {
    if (!keyPattern.test(clave)) throw new Error('Selecciona una clave MAIL válida.')
    const generation = ++detailGeneration
    patch({ selectedClave: clave, thread: null, detailLoading: true, detailError: null, messageLimit })
    try {
      const data = record(await query('mail-get-item', { id: clave, formato: 'texto', maxMensajes: messageLimit, maxCaracteresTexto: 15000, adjuntos: true }))
      const item = parseMailItem(data.item)
      if (item.clave !== clave || !Array.isArray(data.mensajes)) throw new Error('La respuesta no corresponde al hilo seleccionado.')
      if (generation === detailGeneration) patch({ thread: { item, mensajes: records(data.mensajes), totalMensajes: Number(data.totalMensajes ?? data.mensajes.length) }, detailLoading: false })
    } catch (error) { if (generation === detailGeneration) patch({ thread: null, detailLoading: false, detailError: errorMessage(error) }) }
  }
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (state.get().busy) throw new Error('Espera a que termine la operación de correo.')
    patch({ busy: true, composerError: null })
    try { return await work() } catch (error) { patch({ composerError: errorMessage(error) }); throw error } finally { patch({ busy: false }) }
  }
  async function openCompose(modo: string, clave?: string, usarSugerido = false) {
    if (state.get().dirty) throw new Error('Guarda tu borrador antes de abrir otro.')
    await exclusive(async () => {
      const compose = parseCompose(await query('mail-compose-open', { modo, ...(clave ? { clave } : {}), usarSugerido }, true))
      patch({ compose, dirty: false, draft: null }); remember(compose.id)
    })
  }
  function editCompose(value: Partial<MailCompose>) {
    const compose = state.get().compose; if (!compose) return
    editRevision++; patch({ compose: { ...compose, ...value }, dirty: true, composerError: null })
  }
  async function saveCompose() {
    await exclusive(async () => {
      const current = state.get().compose; if (!current) throw new Error('Abre primero un borrador.')
      const revision = editRevision
      if (current.cuerpoMd.length > 50000) throw new Error('Este borrador supera los 50 000 caracteres. Continúa en la vista original.')
      const fields = { asunto: current.asunto, para: current.para, cc: current.cc, cco: current.cco, cuerpoMd: current.cuerpoMd, incluirFirma: current.incluirFirma }
      await query('mail-compose-save', { id: current.id, ...fields }, true)
      const saved = parseCompose(await query('mail-compose-get', { id: current.id }, true))
      if (saved.id !== current.id || saved.cuerpoMd !== current.cuerpoMd || saved.asunto !== current.asunto || ['para', 'cc', 'cco'].some(key => JSON.stringify(saved[key]) !== JSON.stringify(current[key])) || saved.incluirFirma !== current.incluirFirma) throw new Error('El guardado no pudo verificarse. Se conservan tus cambios; revisa antes de repetirlo.')
      if (revision === editRevision) patch({ compose: saved, dirty: false })
      else patch({ compose: { ...state.get().compose!, version: saved.version } })
      remember(saved.id)
    })
  }
  async function resumeCompose() {
    if (state.get().dirty || state.get().busy) return
    let id: string | null = null
    try { id = storage?.getItem(pointerKey) ?? state.get().compose?.id ?? null } catch { /* No persistent pointer. */ }
    if (!id || !localIdPattern.test(id)) return
    try { const compose = parseCompose(await query('mail-compose-get', { id }, true)); if (!state.get().dirty && !state.get().busy) patch({ compose, dirty: false }) }
    catch (error) { patch({ composerError: errorMessage(error) }) }
  }
  function closeCompose() {
    if (state.get().busy || state.get().dirty) throw new Error('Guarda los cambios antes de cerrar el editor.')
    patch({ compose: null, draft: null }); remember(null)
  }
  async function loadDraft() {
    const compose = state.get().compose
    if (!compose?.clave) return
    try { const result = record(await query('mail-draft-get', { id: compose.clave })); if (state.get().compose?.id === compose.id && !state.get().busy) patch({ draft: result.borrador ? record(result.borrador) : null }) }
    catch { /* Editing a saved compose remains available even if its suggestions cannot be read. */ }
  }
  function handoffRoute() {
    const { compose, selectedClave, view, dirty, busy } = state.get()
    if (dirty || busy) throw new Error('Guarda el borrador antes de abrir la vista original.')
    return compose ? `${compose.clave ? `/correo/${compose.clave}` : '/lista'}?redactar=${encodeURIComponent(compose.id)}` : selectedClave ? `/correo/${selectedClave}` : `/${view}`
  }
  async function updateItem(field: string, value: string) {
    const item = state.get().thread?.item; if (!item) throw new Error('Abre un hilo antes de clasificarlo.')
    if (!['estado', 'categoria', 'prioridad'].includes(field)) throw new Error('Campo no permitido.')
    await exclusive(async () => {
      await query('mail-update-item', { id: item.clave, [field]: value }, true)
      const verified = parseMailItem(record(await query('mail-get-item', { id: item.clave, maxMensajes: 1, maxCaracteresTexto: 200 })).item)
      if (verified.clave !== item.clave || verified[field] !== value) throw new Error('La clasificación no pudo verificarse. Actualiza el hilo.')
      if (state.get().thread?.item.clave === item.clave) patch({ thread: { ...state.get().thread!, item: verified } })
      await load(); await overview()
    })
  }
  async function draft(instruction: string, mode: 'generar' | 'ajustar' | 'regenerar' | 'anterior' | 'siguiente', force = false) {
    if (state.get().dirty) await saveCompose()
    await exclusive(async () => {
      const current = state.get().compose; const clave = current?.clave ?? state.get().thread?.item.clave
      if (!clave) throw new Error('El redactor necesita un hilo de correo.')
      const result = record(await query(mode === 'generar' ? 'mail-draft-reply' : mode === 'anterior' || mode === 'siguiente' ? 'mail-draft-version' : 'mail-draft-adjust', mode === 'generar' ? { id: clave, instrucciones: instruction, forzar: force } : mode === 'anterior' || mode === 'siguiente' ? { id: clave, hacia: mode, ...(current ? { composeId: current.id } : {}) } : { id: clave, instruccion: instruction, modo: mode, ...(current ? { composeId: current.id } : {}) }, true))
      if (result.bloqueado || result.estado === 'pregunta') throw new Error(textValue(result.motivo) || textValue(result.pregunta) || textValue(result.mensaje) || 'El redactor necesita aclarar los destinatarios. Abre la vista original para resolverlo.')
      const saved = record(await query('mail-draft-get', { id: clave }))
      if (!saved.borrador) throw new Error('El redactor no confirmó un borrador guardado.')
      const compose = parseCompose(await query('mail-compose-open', { modo: current?.modo ?? 'responder', clave, usarSugerido: true, reemplazar: true }, true))
      patch({ compose, draft: record(saved.borrador), dirty: false }); remember(compose.id)
    })
  }
  async function boot() { await Promise.all([load(), overview()]); if (!restoreAttempted) { restoreAttempted = true; await resumeCompose() } }
  return { state, load, overview, filter, navigate, select, openCompose, editCompose, saveCompose, closeCompose, handoffRoute, updateItem, draft, boot, resumeCompose, loadDraft, setLegacy: (legacy: boolean) => patch({ legacy }), query }
}
