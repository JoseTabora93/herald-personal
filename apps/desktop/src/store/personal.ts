import { atom } from 'nanostores'
import { createPersonalController } from '../features/personal/controller.ts'
import type { PersonalTab } from '../features/personal/model.ts'

export const personal = createPersonalController(async request => {
  if (!window.heraldOS?.personal) throw new Error('El servicio personal no está disponible en esta ventana. Abre la aplicación de escritorio y revisa la conexión del servicio.')
  return window.heraldOS.personal.request(request)
})

export const $personal = personal.state
export interface PersonalFocus {
  tab: PersonalTab
  taskId?: string
  compose?: boolean
  mailId?: string
  mailAction?: 'draft' | 'archive' | 'undo'
  actionId?: string
  resetMail?: boolean
  checkinDate?: string
  query?: string
  status?: string
  tick: number
}
export const $personalFocus = atom<PersonalFocus>({ tab: 'today', tick: 0 })
export function focusPersonal(focus: Omit<PersonalFocus, 'tick'>) {
  $personalFocus.set({ ...focus, tick: $personalFocus.get().tick + 1 })
}
