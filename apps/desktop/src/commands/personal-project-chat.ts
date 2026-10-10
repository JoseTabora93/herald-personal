import { $personal, focusPersonal } from '../store/personal.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'

const idArg = { name: 'id', type: 'string', description: 'Identificador del proyecto', required: true } as const
const textArg = { name: 'text', type: 'string', description: 'Mensaje escrito por el usuario', required: true } as const
const project = (id: unknown) => {
  const found = $personal.get().projects.find(p => p.id === id)
  if (!found) throw new Error('Actualiza Proyectos y selecciona un proyecto disponible.')
  return found
}

export const projectChatCommands: readonly OsCommand[] = [
  { id: 'personal.project.chat.open', title: 'Conversar con Hermes sobre el proyecto', description: 'Abrir su chat e historial; no envía mensajes.', tier: 'read', args: [idArg], run: async ({ id }) => {
    const value = project(id)
    const { $projectChatOpen } = await import('../store/project-chat.ts')
    focusPersonal({ tab: 'projects', projectId: value.id }); showPage('personal'); $projectChatOpen.set(true)
    return ok(`Chat de ${value.name} abierto.`, { page: 'personal' })
  } },
  { id: 'personal.project.chat.close', title: 'Minimizar chat del proyecto', description: 'Ocultar la ventana conservando conversación y borrador.', tier: 'read', args: [], run: async () => {
    const { $projectChatOpen } = await import('../store/project-chat.ts'); $projectChatOpen.set(false)
    return ok('Chat minimizado; la respuesta continúa si estaba en curso.')
  } },
  { id: 'personal.project.chat.refresh', title: 'Actualizar conversación del proyecto', description: 'Reconectar y consultar el historial y el rumbo guardado.', tier: 'read', args: [idArg], run: async ({ id }) => {
    project(id); const { projectChats } = await import('../store/project-chat.ts')
    await projectChats.open(String(id)); return ok('Conversación y rumbo actualizados.')
  } },
  { id: 'personal.project.chat.select', title: 'Retomar chat del proyecto', description: 'Seleccionar una conversación guardada del mismo proyecto; vacío prepara una nueva.', tier: 'read', args: [idArg, { name: 'sessionId', type: 'string', description: 'ID guardado de la conversación' }], run: async ({ id, sessionId }) => {
    project(id); const { projectChats } = await import('../store/project-chat.ts')
    await projectChats.select(String(id), sessionId ? String(sessionId) : null); return ok(sessionId ? 'Conversación retomada.' : 'Lista una nueva conversación; se guardará cuando envíes el primer mensaje.')
  } },
  { id: 'personal.project.chat.send', title: 'Enviar mensaje al chat del proyecto', description: 'Pedir orientación o acciones a Hermes en la conversación del proyecto.', tier: 'act', args: [idArg, textArg], run: async ({ id, text }) => {
    project(id)
    if (!String(text).trim() || String(text).length > 20000) return fail('Escribe un mensaje de hasta 20 000 caracteres.')
    const { projectChats } = await import('../store/project-chat.ts')
    await projectChats.send(String(id), String(text)); return ok('Mensaje enviado a Hermes; las acciones se confirman en sus resultados.')
  } },
  { id: 'personal.project.chat.stop', title: 'Detener respuesta del proyecto', description: 'Interrumpir a Hermes en esta conversación; no cancela agentes externos.', tier: 'act', args: [idArg], run: async ({ id }) => {
    project(id); const { projectChats } = await import('../store/project-chat.ts')
    await projectChats.interrupt(String(id)); return ok('Interrupción solicitada para esta conversación.')
  } },
  { id: 'personal.project.chat.suggest', title: 'Preparar consulta del proyecto', description: 'Poner una sugerencia en el borrador sin enviarla.', tier: 'read', args: [idArg, textArg], run: async ({ id, text }) => {
    project(id); const { projectDraftKey } = await import('../store/project-chat.ts')
    const { setChatDraft } = await import('../store/chat-drafts.ts')
    setChatDraft(projectDraftKey(String(id)), String(text)); return ok('Borrador preparado; revísalo antes de enviar.')
  } }
]
