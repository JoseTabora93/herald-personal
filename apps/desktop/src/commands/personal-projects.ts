import { safeProjectPr } from '../features/personal/projects-model.ts'
import { $personal, focusPersonal, personal } from '../store/personal.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { openWebWindow } from '../store/web-windows.ts'
import { showPage } from '../store/windows.ts'

const args = [
  { name: 'id', type: 'string', description: 'Identificador del proyecto', required: true },
  { name: 'taskId', type: 'string', description: 'Identificador de una tarea dentro del proyecto' }
] as const

export const projectCommands: readonly OsCommand[] = [
  {
    id: 'personal.projects.refresh', title: 'Actualizar dashboard de proyectos', description: 'Consultar el último estado recibido y su fecha; las fuentes se sincronizan según su horario.', tier: 'read', args: [],
    run: async () => {
      await personal.loadProjects()
      const data = $personal.get()
      return data.projectsError ? fail(data.projectsError) : ok('Dashboard actualizado con la evidencia guardada.', { data: { projects: data.projects } })
    }
  },
  {
    id: 'personal.project.select', title: 'Ver seguimiento de proyecto', description: 'Abrir el dashboard de un proyecto y el detalle de una tarea.', tier: 'read', args,
    run: ({ id, taskId }) => {
      const project = $personal.get().projects.find(item => item.id === id)
      if (!project || (taskId && !project.items.some(item => item.task.id === taskId))) return fail('Actualiza Proyectos y selecciona una tarea del proyecto.')
      focusPersonal({ tab: 'projects', projectId: project.id, ...(taskId ? { projectItemId: String(taskId) } : {}) })
      showPage('personal')
      return ok(`Seguimiento de ${project.name}.`, { page: 'personal' })
    }
  },
  {
    id: 'personal.project.pr', title: 'Ver PR del proyecto', description: 'Abrir el PR de GitHub vinculado en una ventana de Herald.', tier: 'read', args,
    run: async ({ id, taskId }) => {
      const project = $personal.get().projects.find(item => item.id === id)
      const pr = project?.items.find(item => item.task.id === taskId)?.pr
      const url = pr && safeProjectPr(pr.url)
      if (!project || !pr || !url) return fail('Esta tarea no tiene un PR válido vinculado.')
      await openWebWindow(url, { title: `PR #${pr.number} · ${project.name}` })
      return ok('PR abierto en Herald.', { page: 'personal' })
    }
  }
]
