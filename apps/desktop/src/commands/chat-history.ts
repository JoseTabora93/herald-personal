import { $activeChat, forgetChat, openStoredSession, renameChat } from '../store/chat.ts'
import { $chatResultsOpen, $history, $historyOpen, deleteSession, loadMoreSessions, refreshSessions, searchSessions } from '../store/sessions.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'

const historyResult = () => $history.get().error ? fail($history.get().error!) : ok('Historial actualizado', { data: { total: $history.get().total } })
export const chatHistoryCommands: readonly OsCommand[] = [
  { id: 'chat.history.toggle', title: 'Mostrar historial', description: 'Mostrar u ocultar conversaciones guardadas.', tier: 'read', args: [], run: () => { $historyOpen.set(!$historyOpen.get()); return ok('Historial actualizado') } },
  { id: 'chat.results.toggle', title: 'Mostrar resultados', description: 'Mostrar u ocultar archivos y resultados de la conversación.', tier: 'read', args: [], run: () => { $chatResultsOpen.set(!$chatResultsOpen.get()); return ok('Resultados actualizados') } },
  { id: 'chat.history.refresh', title: 'Actualizar historial', description: 'Volver a consultar el historial de Hermes.', tier: 'read', args: [], run: async () => { await refreshSessions(); return historyResult() } },
  { id: 'chat.history.more', title: 'Cargar conversaciones anteriores', description: 'Leer la siguiente página de conversaciones.', tier: 'read', args: [], run: async () => { await loadMoreSessions(); return historyResult() } },
  { id: 'chat.history.search', title: 'Buscar conversaciones', description: 'Buscar por título, contenido o ID; la búsqueda incluye archivadas.', tier: 'read', args: [{ name: 'query', type: 'string', description: 'Texto de búsqueda' }, { name: 'archived', type: 'boolean', description: 'Incluir archivadas en la lista' }], run: async ({ query, archived }) => { await searchSessions(String(query ?? ''), Boolean(archived)); return historyResult() } },
  { id: 'chat.resume', title: 'Retomar conversación', description: 'Abrir una conversación por su ID guardado.', tier: 'read', args: [{ name: 'id', type: 'string', required: true, description: 'ID guardado de la conversación' }], run: async ({ id }) => { await openStoredSession(String(id)); return ok('Conversación abierta') } },
  { id: 'chat.rename', title: 'Renombrar conversación', description: 'Guardar el título en Hermes.', tier: 'mutate', args: [{ name: 'title', type: 'string', required: true, description: 'Título' }], run: async ({ title }) => { const chat = $activeChat.get(); if (!chat) return fail('Abre una conversación primero.'); await renameChat(chat.sessionId, String(title)); return ok('Título guardado') } },
  { id: 'chat.delete', title: 'Eliminar conversación', description: 'Eliminar la conversación activa después de confirmarlo.', tier: 'destructive', args: [{ name: 'id', type: 'string', required: true, description: 'ID guardado que se confirmó' }, { name: 'confirmed', type: 'boolean', required: true, description: 'Confirmación explícita' }], run: async ({ id, confirmed }) => {
    const chat = $activeChat.get()
    if (!chat || chat.storedSessionId !== id || confirmed !== true) return fail('Confirma la conversación que quieres eliminar.')
    if (chat.streaming) return fail('Detén la respuesta antes de eliminar la conversación.')
    await deleteSession(chat.storedSessionId); forgetChat(chat.sessionId); return ok('Conversación eliminada')
  } }
]
