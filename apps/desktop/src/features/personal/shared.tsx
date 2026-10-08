import { useStore } from '@nanostores/react'
import { IconRefresh, IconWifiOff } from '@tabler/icons-react'
import { cloneElement, isValidElement, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { GlassButton, GlassCard, Pill } from '../../components/ui/glass.tsx'
import { runCommand, type CommandResult } from '../../store/os-commands.ts'
import { $personal } from '../../store/personal.ts'
import { dateLabel, PROVIDER_NAMES, providerLabel } from './model.ts'

export const FIELD_CLASS = 'glass-input w-full rounded-lg px-3 py-2 text-[13px] text-fg outline-none focus:ring-2 focus:ring-accent/50 disabled:opacity-50'

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId()
  const control = isValidElement(children) ? cloneElement(children as ReactElement<{ 'aria-labelledby'?: string; 'aria-describedby'?: string }>, { 'aria-labelledby': `${id}-label`, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) }) : children
  return <label className="flex min-w-0 flex-col gap-1.5 text-[12px] text-fg-2"><span id={`${id}-label`}>{label}</span>{control}{hint && <span id={`${id}-hint`} className="text-[11px] text-fg-3">{hint}</span>}</label>
}

export function usePersonalAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const running = useRef(false)
  const run = async (id: string, args: Record<string, unknown> = {}): Promise<CommandResult | null> => {
    if (running.current) return null
    running.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await runCommand(id, args, { source: 'ui' })
      if (!result.ok) { setError(result.error ?? result.summary); return null }
      setNotice(result.summary)
      return result
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return { busy, error, notice, run, clear: () => { setError(null); setNotice(null) } }
}

export function ActionFeedback({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (error) return <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-[12px] text-danger">{error}</div>
  if (notice) return <div role="status" className="rounded-lg border border-ok/25 bg-ok/10 p-3 text-[12px] text-ok">{notice}</div>
  return null
}

export function ProviderConnections({ sync = false }: { sync?: boolean }) {
  const data = useStore($personal)
  const action = usePersonalAction()
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[14px] font-semibold text-fg">Conexiones de correo</h2><Pill tone={data.status?.capabilities.mail_archive || data.status?.capabilities.mail_draft ? 'warn' : 'muted'}>{data.status?.capabilities.mail_archive || data.status?.capabilities.mail_draft ? 'Escritura con confirmación' : 'Lectura y clasificación'}</Pill></div>
    {data.providers.length ? <div className="grid gap-3 sm:grid-cols-2">{data.providers.map(provider => <GlassCard key={provider.provider} className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[13px] font-medium">{PROVIDER_NAMES[provider.provider]}</span><Pill tone={provider.connected && !provider.error ? 'ok' : 'muted'} dot>{providerLabel(provider)}</Pill></div>
      <p className="mt-2 text-[12px] text-fg-3">{provider.last_sync_at ? `Última sincronización: ${dateLabel(provider.last_sync_at, true)}` : 'Todavía no hay una sincronización confirmada.'}</p>
      {provider.error && <p className="mt-2 break-words text-[12px] text-warn">{provider.error}</p>}
      {!provider.configured && <p className="mt-2 text-[12px] text-fg-3">El operador debe conectar esta cuenta al servicio personal.</p>}
      {sync && <GlassButton size="sm" className="mt-3" disabled={action.busy || !provider.configured || !data.status?.capabilities.mail_read} onClick={() => void action.run('personal.mail.sync', { provider: provider.provider })}><IconRefresh />Sincronizar</GlassButton>}
    </GlassCard>)}</div> : <div className="flex items-center gap-3 rounded-xl border border-line p-4 text-[12px] text-fg-3"><IconWifiOff size={20} /><span>Conecta el servicio personal para consultar el estado de tus cuentas. La configuración se realiza fuera de esta ventana.</span></div>}
    <ActionFeedback {...action} />
  </div>
}
