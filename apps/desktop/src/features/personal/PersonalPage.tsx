import { useStore } from '@nanostores/react'
import { IconBook, IconChecklist, IconCode, IconMail, IconPlus, IconRefresh, IconSun, IconWifiOff } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { GlassButton, PageHeader, Pill, Tabs, type TabDef } from '../../components/ui/glass.tsx'
import { $personal, $personalFocus, personal } from '../../store/personal.ts'
import { DevelopmentPanel } from './DevelopmentPanel.tsx'
import { JournalPanel } from './JournalPanel.tsx'
import { MailPanel } from './MailPanel.tsx'
import { dateLabel, TAB_LABELS, type PersonalTab } from './model.ts'
import { ActionFeedback, usePersonalAction } from './shared.tsx'
import { TaskPanel } from './TaskPanel.tsx'
import { TodayPanel } from './TodayPanel.tsx'

const tabs: readonly TabDef<PersonalTab>[] = [
  { id: 'today', label: TAB_LABELS.today, icon: <IconSun size={15} /> },
  { id: 'mail', label: TAB_LABELS.mail, icon: <IconMail size={15} /> },
  { id: 'tasks', label: TAB_LABELS.tasks, icon: <IconChecklist size={15} /> },
  { id: 'journal', label: TAB_LABELS.journal, icon: <IconBook size={15} /> },
  { id: 'development', label: TAB_LABELS.development, icon: <IconCode size={15} /> }
]

export function PersonalPage() {
  const data = useStore($personal)
  const focus = useStore($personalFocus)
  const action = usePersonalAction()
  const visited = useRef(new Set<PersonalTab>())
  visited.current.add(focus.tab)
  useEffect(() => { void personal.refresh() }, [])
  return <div className="page-enter flex h-full flex-col text-fg">
    <PageHeader icon="overview" title="Personal" subtitle="Tu correo, compromisos y seguimiento diario." actions={<><Pill tone={data.error ? 'warn' : data.lastLoadedAt ? 'ok' : 'muted'} dot>{data.loading ? 'Actualizando' : data.error ? 'Sin actualizar' : data.lastLoadedAt ? 'Servicio conectado' : 'Conexión pendiente'}</Pill><GlassButton size="icon" aria-label="Actualizar espacio personal" disabled={data.loading || action.busy} onClick={() => void action.run('personal.refresh')}><IconRefresh className={data.loading ? 'animate-spin' : ''} /></GlassButton><GlassButton variant="primary" onClick={() => void action.run('personal.task.new')}><IconPlus />Compromiso</GlassButton></>} />
    <div className="shrink-0 overflow-x-auto px-6 pb-4"><Tabs tabs={tabs} value={focus.tab} onChange={tab => void action.run('personal.open', { tab })} /></div>
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      {data.error && <div role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 p-4"><IconWifiOff className="mt-0.5 shrink-0 text-warn" size={20} /><div className="min-w-0 text-[12px]"><p className="font-medium text-fg">{data.lastLoadedAt ? 'No se pudo actualizar. Se conserva la última consulta.' : 'El servicio personal necesita conexión.'}</p><p className="mt-1 break-words text-fg-2">{data.error}</p><p className="mt-2 text-fg-3">{data.lastLoadedAt ? `Última consulta: ${dateLabel(data.lastLoadedAt, true)}.` : 'El operador puede revisar la dirección del servicio y su acceso. Las credenciales se configuran fuera de esta ventana.'}</p></div></div>}
      {action.error && <div className="mb-4"><ActionFeedback error={action.error} /></div>}
      {data.loading && !data.lastLoadedAt ? <div role="status" aria-label="Cargando espacio personal" className="grid gap-3"><div className="shimmer h-32 rounded-xl" /><div className="grid grid-cols-3 gap-3"><div className="shimmer h-24 rounded-xl" /><div className="shimmer h-24 rounded-xl" /><div className="shimmer h-24 rounded-xl" /></div></div> : [...visited.current].map(tab => <section key={tab} hidden={focus.tab !== tab} role="tabpanel" aria-label={TAB_LABELS[tab]}>
        {tab === 'today' && <TodayPanel />}
        {tab === 'mail' && <MailPanel />}
        {tab === 'tasks' && <TaskPanel />}
        {tab === 'journal' && <JournalPanel />}
        {tab === 'development' && <DevelopmentPanel />}
      </section>)}
    </div>
  </div>
}
