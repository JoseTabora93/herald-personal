import type { PersonalMailCategory, PersonalPriority, PersonalProvider, PersonalTaskStatus } from '../../shared/personal.ts'
import { buildTaskCreate, buildTaskPatch, errorMessage, localDate, TAB_LABELS, TASK_STATUS, type PersonalTab, type TaskForm } from '../features/personal/model.ts'
import { safeMailUrl } from '../features/personal/model.ts'
import { $personal, focusPersonal, personal } from '../store/personal.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { openWebWindow } from '../store/web-windows.ts'
import { showPage } from '../store/windows.ts'

const idArg = { name: 'id', type: 'string', description: 'Identificador del elemento', required: true } as const
const open = (focus: Parameters<typeof focusPersonal>[0]) => { focusPersonal(focus); showPage('personal') }
const taskArgs = [
  { name: 'id', type: 'string', description: 'Identificador; vacío para crear' },
  { name: 'title', type: 'string', description: 'Título del compromiso', required: true },
  { name: 'description', type: 'string', description: 'Detalle del compromiso' },
  { name: 'status', type: 'string', description: 'Estado', enum: Object.keys(TASK_STATUS) },
  { name: 'priority', type: 'string', description: 'Prioridad', enum: ['normal', 'high', 'low'] },
  { name: 'dueDate', type: 'string', description: 'Fecha local YYYY-MM-DD' },
  { name: 'originalDueAt', type: 'string', description: 'Fecha y hora de la revisión leída; se conserva si el día no cambia' },
  { name: 'project', type: 'string', description: 'Proyecto' },
  { name: 'revision', type: 'number', description: 'Revisión que se está editando' },
  { name: 'idempotencyKey', type: 'string', description: 'Referencia estable del formulario nuevo' }
] as const

const commands: readonly OsCommand[] = [
  {
    id: 'personal.development.refresh', title: 'Actualizar ejecuciones de desarrollo', description: 'Leer las ejecuciones reales y su evidencia disponible.', tier: 'read', args: [],
    run: async () => { await personal.loadAgentRuns(); const error = $personal.get().agentRunsError; return error ? fail(error) : ok('Ejecuciones actualizadas. La validación se indica por separado.') }
  },
  {
    id: 'personal.open', title: 'Abrir mi espacio personal', description: 'Ver Hoy, Correo, Compromisos, Diario o Desarrollo.', tier: 'read',
    args: [{ name: 'tab', type: 'string', description: 'Sección personal', enum: Object.keys(TAB_LABELS) }],
    phrases: ['abrir mi espacio personal', 'ver mi día', { phrase: 'abrir mi correo', args: { tab: 'mail' } }, { phrase: 'ver mis compromisos', args: { tab: 'tasks' } }, { phrase: 'abrir mi diario', args: { tab: 'journal' } }, { phrase: 'supervisar desarrollo', args: { tab: 'development' } }],
    run: ({ tab }) => { const target = (tab ?? 'today') as PersonalTab; open({ tab: target }); return ok(`Abierto: ${TAB_LABELS[target]}.`, { page: 'personal' }) }
  },
  {
    id: 'personal.refresh', title: 'Actualizar espacio personal', description: 'Consultar el servicio y actualizar los registros guardados.', tier: 'read', args: [],
    run: async () => { await personal.refresh(); const state = $personal.get(); return state.error ? fail(state.error) : ok('Espacio personal actualizado.', { page: 'personal' }) }
  },
  {
    id: 'personal.task.new', title: 'Nuevo compromiso', description: 'Abrir un formulario para capturar un compromiso.', tier: 'act', args: [], phrases: ['nuevo compromiso', 'anotar un pendiente'],
    run: () => { open({ tab: 'tasks', compose: true }); return ok('Formulario de nuevo compromiso abierto.', { page: 'personal' }) }
  },
  {
    id: 'personal.task.show', title: 'Ver compromiso', description: 'Abrir un compromiso y su revisión.', tier: 'read', args: [idArg],
    run: async ({ id }) => { const task = await personal.getTask(String(id)); open({ tab: 'tasks', taskId: task.id }); return ok(`Compromiso: ${task.title}.`, { page: 'personal', data: { task } }) }
  },
  {
    id: 'personal.task.save', title: 'Guardar compromiso', description: 'Crear con referencia estable o editar con la revisión que se leyó.', tier: 'mutate', args: taskArgs, hidden: true,
    run: async args => {
      const form: TaskForm = { title: String(args.title ?? ''), description: String(args.description ?? ''), status: (args.status ?? 'inbox') as PersonalTaskStatus, priority: (args.priority ?? 'normal') as PersonalPriority, dueDate: String(args.dueDate ?? ''), project: String(args.project ?? '') }
      const task = args.id ? await personal.updateTask(String(args.id), buildTaskPatch(form, Number(args.revision), args.originalDueAt ? String(args.originalDueAt) : null)) : await personal.createTask(buildTaskCreate(form, String(args.idempotencyKey ?? '')))
      open({ tab: 'tasks', taskId: task.id })
      return ok('Compromiso guardado.', { page: 'personal', data: { task } })
    }
  },
  {
    id: 'personal.task.status', title: 'Cambiar estado de compromiso', description: 'Actualizar el estado con control de revisión.', tier: 'mutate',
    args: [idArg, { name: 'status', type: 'string', description: 'Estado', required: true, enum: Object.keys(TASK_STATUS) }, { name: 'revision', type: 'number', description: 'Revisión leída', required: true }],
    run: async ({ id, status, revision }) => { const task = await personal.updateTask(String(id), { status, expected_revision: Number(revision) }); return ok(`Estado: ${TASK_STATUS[task.status]}.`, { data: { task } }) }
  },
  {
    id: 'personal.tasks.filter', title: 'Filtrar compromisos', description: 'Buscar compromisos por texto y estado.', tier: 'read',
    args: [{ name: 'query', type: 'string', description: 'Texto a buscar' }, { name: 'status', type: 'string', description: 'Estado, open, overdue o all' }],
    run: ({ query, status }) => { open({ tab: 'tasks', query: String(query ?? ''), status: String(status ?? 'open') }); return ok('Filtro de compromisos aplicado.', { page: 'personal' }) }
  },
  {
    id: 'personal.mail.search', title: 'Buscar correo', description: 'Buscar en la copia sincronizada por texto y categoría.', tier: 'read',
    args: [{ name: 'query', type: 'string', description: 'Texto a buscar' }, { name: 'category', type: 'string', description: 'Categoría' }],
    run: async ({ query, category }) => { open({ tab: 'mail' }); await personal.searchMail(String(query ?? ''), String(category ?? '')); const error = $personal.get().mailError; return error ? fail(error) : ok('Correo actualizado.', { page: 'personal' }) }
  },
  {
    id: 'personal.mail.page', title: 'Cambiar página de correo', description: 'Consultar los correos anteriores o siguientes con los filtros actuales.', tier: 'read',
    args: [{ name: 'direction', type: 'string', description: 'Dirección', required: true, enum: ['next', 'previous'] }],
    run: async ({ direction }) => { open({ tab: 'mail' }); await personal.pageMail(direction as 'next' | 'previous'); const error = $personal.get().mailError; return error ? fail(error) : ok('Página de correo actualizada.', { page: 'personal' }) }
  },
  {
    id: 'personal.mail.show', title: 'Ver correo', description: 'Seleccionar un mensaje como texto; no ejecuta su contenido.', tier: 'read', args: [idArg],
    run: ({ id }) => { open({ tab: 'mail', mailId: String(id) }); return ok('Correo abierto.', { page: 'personal' }) }
  },
  {
    id: 'personal.mail.sync', title: 'Sincronizar correo', description: 'Leer novedades del proveedor configurado.', tier: 'read',
    args: [{ name: 'provider', type: 'string', description: 'Proveedor de correo', required: true, enum: ['gmail', 'microsoft365'] }],
    run: async ({ provider }) => { const result = await personal.syncMail(provider as PersonalProvider); return ok(`Sincronización completada: ${result.count} ${result.count === 1 ? 'mensaje' : 'mensajes'}.`, { page: 'personal' }) }
  },
  {
    id: 'personal.mail.category', title: 'Clasificar correo', description: 'Cambiar la categoría local de un mensaje.', tier: 'mutate',
    args: [idArg, { name: 'category', type: 'string', description: 'Categoría', required: true, enum: ['urgent', 'action', 'waiting', 'reference', 'newsletter'] }],
    run: async ({ id, category }) => { await personal.categorizeMail(String(id), category as PersonalMailCategory); return ok('Categoría guardada.') }
  },
  {
    id: 'personal.mail.capture', title: 'Crear compromiso desde correo', description: 'Capturar el mensaje una sola vez como compromiso durable.', tier: 'mutate', args: [idArg],
    run: async ({ id }) => { const task = await personal.captureMail(String(id)); return ok('Correo vinculado a un compromiso.', { data: { task } }) }
  },
  ...(['draft', 'archive'] as const).map(operation => ({
    id: `personal.mail.${operation}`, title: operation === 'draft' ? 'Preparar borrador de correo' : 'Revisar archivo de correo',
    description: 'Abrir la revisión y confirmación humana antes de escribir en el proveedor.', tier: 'act' as const, args: [idArg],
    run: ({ id }: Record<string, unknown>) => { open({ tab: 'mail', mailId: String(id), mailAction: operation }); return ok('Revisa la acción y confírmala en Correo.', { page: 'personal' }) }
  })),
  {
    id: 'personal.mail.undo', title: 'Revisar deshacer archivo', description: 'Abrir la confirmación para restaurar el mensaje archivado.', tier: 'act', args: [idArg],
    run: ({ id }) => { open({ tab: 'mail', mailAction: 'undo', actionId: String(id) }); return ok('Confirma la restauración del mensaje en Correo.', { page: 'personal' }) }
  },
  {
    id: 'personal.mail.cancel', title: 'Cerrar confirmación de correo', description: 'Cerrar el formulario de revisión sin escribir en el proveedor.', tier: 'act', args: [], hidden: true,
    run: () => { open({ tab: 'mail', resetMail: true }); return ok('Confirmación cerrada.') }
  },
  {
    id: 'personal.mail.confirmWrite', title: 'Confirmar acción de correo', description: 'Control de confirmación humana de borrador, archivo o restauración.', tier: 'mutate', hidden: true,
    args: [idArg, { name: 'operation', type: 'string', description: 'Acción a confirmar', required: true, enum: ['draft', 'archive', 'undo'] }, { name: 'body', type: 'string', description: 'Texto completo del borrador' }, { name: 'confirmed', type: 'boolean', description: 'Confirmación explícita', required: true }],
    run: async ({ id, operation, body, confirmed }, context) => {
      if (context.source !== 'ui' || confirmed !== true) return fail('Confirma esta acción personalmente en la pantalla Correo.')
      if (operation === 'draft') { const result = await personal.saveDraft(String(id), String(body ?? ''), true); return ok('Borrador guardado en el proveedor; no se envió.', { data: result }) }
      if (operation === 'archive') { const result = await personal.archiveMail(String(id), true); return ok('Mensaje archivado. Puedes deshacer esta acción.', { data: result }) }
      await personal.undoArchive(String(id), true)
      return ok('Mensaje restaurado.')
    }
  },
  {
    id: 'personal.mail.openProvider', title: 'Abrir correo en el proveedor', description: 'Abrir el enlace verificado de Gmail o Microsoft 365 dentro de Herald.', tier: 'act', args: [idArg],
    run: ({ id }) => { const mail = $personal.get().mail.find(item => item.id === id); const url = safeMailUrl(mail?.web_url ?? null); if (!url) return fail('Este mensaje no tiene un enlace válido del proveedor.'); openWebWindow(url, { title: mail?.subject || 'Correo' }); return ok('Proveedor abierto dentro de Herald.') }
  },
  {
    id: 'personal.checkin.open', title: 'Abrir diario personal', description: 'Ver o editar la entrada de una fecha local.', tier: 'read', args: [{ name: 'date', type: 'string', description: 'Fecha YYYY-MM-DD' }],
    run: ({ date }) => { open({ tab: 'journal', checkinDate: String(date ?? localDate()) }); return ok('Diario abierto.', { page: 'personal' }) }
  },
  {
    id: 'personal.checkin.save', title: 'Guardar diario', description: 'Guardar logros, pendientes y siguiente día sin modificar compromisos.', tier: 'mutate', hidden: true,
    args: [{ name: 'date', type: 'string', description: 'Fecha local', required: true }, ...(['accomplished', 'pending', 'tomorrow'] as const).map(name => ({ name, type: 'string' as const, description: name }))],
    run: async ({ date, accomplished, pending, tomorrow }) => { const checkin = await personal.saveCheckin(String(date), { accomplished: String(accomplished ?? ''), pending: String(pending ?? ''), tomorrow: String(tomorrow ?? '') }); return ok('Entrada de diario guardada.', { data: { checkin } }) }
  },
  {
    id: 'personal.brief', title: 'Preparar resumen del día', description: 'Obtener un resumen estructurado de los registros reales.', tier: 'read',
    args: [{ name: 'kind', type: 'string', description: 'Inicio o cierre del día', enum: ['morning', 'evening'] }],
    run: async ({ kind }) => { const brief = await personal.loadBrief((kind ?? 'morning') as 'morning' | 'evening'); return ok('Resumen preparado con los registros guardados.', { data: { brief } }) }
  }
]

export const personalCommands: readonly OsCommand[] = commands.map<OsCommand>(command => ({
  ...command,
  run: async (args, context) => {
    try { return await command.run(args, context) }
    catch (error) { return fail(errorMessage(error)) }
  }
}))
