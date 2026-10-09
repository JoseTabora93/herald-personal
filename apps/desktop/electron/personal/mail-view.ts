/** Only the configured mail origin and its domain views may enter the isolated guest. */
const paths = /^\/(?:tablero|lista|seguimiento|aprendizajes|limpieza|rezagados|historico|auto-lectura|correo\/MAIL-[1-9][0-9]{0,14})$/
const filters = new Set(['q', 'categoria', 'estado', 'prioridad', 'atrasados', 'noleidos', 'duda', 'sinclasificar', 'revisado', 'para', 'antiguos', 'carpeta', 'periodo', 'agrupar', 'orden', 'dir', 'pagina', 'de', 's', 'herald', 'redactar', 'umbral', 'anio', 'remitente'])

function mailOrigin(raw: string): string {
  const url = new URL(raw)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('El origen del correo no es válido.')
  return url.origin
}

export function mailViewUrl(origin: string, route = '/tablero'): string {
  const base = mailOrigin(origin)
  if (typeof route !== 'string' || route.length > 3000 || /[#\\\x00-\x20]/.test(route)) throw new Error('La vista de correo no está permitida.')
  const parts = route.split('?')
  if (parts.length > 2 || !paths.test(parts[0])) throw new Error('La vista de correo no está permitida.')
  const query = new URLSearchParams(parts[1] ?? '')
  const seen = new Set<string>()
  for (const [key, value] of query) {
    if (!filters.has(key) || seen.has(key) || value.length > 500 || /[\x00-\x1f]/.test(value) ||
        (key === 'herald' && value !== '1') || (['pagina', 'umbral', 'anio'].includes(key) && !/^[1-9][0-9]{0,5}$/.test(value)) ||
        (key === 'redactar' && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) {
      throw new Error('El filtro de correo no está permitido.')
    }
    seen.add(key)
  }
  query.set('herald', '1')
  return `${base}${parts[0]}?${query.toString()}`
}

export function mailViewAllows(origin: string, target: string): boolean {
  try {
    const base = mailOrigin(origin)
    const url = new URL(target)
    if (url.origin !== base || url.username || url.password || url.hash) return false
    mailViewUrl(base, `${url.pathname}${url.search}`)
    return true
  } catch { return false }
}

export function personalPlanRequest(argv: string[]): { date: string } | null {
  if (argv.filter(value => value === '--personal-plan').length !== 1) return null
  const day = argv[argv.indexOf('--personal-plan') + 1]
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const parsed = new Date(`${day}T12:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null
  return { date: day }
}
