import { atom } from 'nanostores'
import { createPersonalController } from '../features/personal/controller.ts'
import type { PersonalTab } from '../features/personal/model.ts'
import { createMailWorkspaceController } from '../features/personal/mail-workspace.ts'
import { createNativeMailController } from '../features/personal/native-mail.ts'

export const nativeMail = createNativeMailController(request => window.heraldOS.personal.request(request), {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key)
})

export const personal = createPersonalController(async request => {
  if (!window.heraldOS?.personal) throw new Error('El servicio personal no está disponible en esta ventana. Abre la aplicación de escritorio y revisa la conexión del servicio.')
  return window.heraldOS.personal.request(request)
})

export const $personal = personal.state
export const mailWorkspace = createMailWorkspaceController({
  open: route => window.heraldOS.personal.mailOpen(route),
  navigate: (id, route) => window.heraldOS.personal.mailNavigate(id, route),
  reload: id => window.heraldOS.web.reload(id),
  close: id => window.heraldOS.web.close(id),
  onEvent: listener => window.heraldOS.web.onEvent(listener)
})
export interface PersonalFocus {
  tab: PersonalTab
  projectId?: string
  projectItemId?: string
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
