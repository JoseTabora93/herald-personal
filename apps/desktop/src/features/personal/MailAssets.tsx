import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import type { PersonalMailAsset } from '../../../shared/personal.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { assetKey, mailAssets } from './mail-assets.ts'
import { ActionFeedback, usePersonalAction } from './shared.tsx'

export function MailAttachment({ asset, name, mime, size, inline }: { asset: PersonalMailAsset; name: string; mime: string; size: number; inline: boolean }) {
  const preview = useStore(mailAssets.state), action = usePersonalAction()
  const args = { ref: JSON.stringify(asset), name }
  const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)
  return <li className="rounded-lg border border-line p-3">
    <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words">{name} · {Math.ceil(size / 1024)} KB {inline ? '· Imagen en el mensaje' : ''}</span>
      {image && <GlassButton size="sm" disabled={action.busy} onClick={() => void action.run('personal.nativeMail.asset', { ...args, intent: 'preview' })}>Ver imagen</GlassButton>}
      <GlassButton size="sm" disabled={action.busy} onClick={() => void action.run('personal.nativeMail.asset', { ...args, intent: 'download' })}>Descargar {image ? 'imagen' : 'adjunto'}</GlassButton>
    </div>
    {preview.key === assetKey(asset) && preview.src && <img className="mt-3 max-h-96 max-w-full rounded bg-white object-contain" src={preview.src} alt={name} />}
    <ActionFeedback error={action.error} notice={action.notice} />
  </li>
}

export function SignaturePreview({ composeId }: { composeId: string }) {
  const [src, setSrc] = useState<string | null>(null), [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setSrc(null); setError(null)
    void window.heraldOS.personal.mailAsset({ kind: 'signature' }, 'preview').then(result => { if (current) setSrc(result.dataUrl || null) }).catch(() => { if (current) setError('No se pudo cargar la firma configurada. Revisa la firma en la vista original antes de enviar.') })
    return () => { current = false }
  }, [composeId])
  return <div aria-label="Firma de la respuesta" className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
    <p className="mb-2 text-[11px] text-fg-3">Tu firma se agregará al final de esta respuesta.</p>
    {src ? <img src={src} alt="Mi firma de correo configurada" className="max-h-52 max-w-full bg-white object-contain" /> : <p role={error ? 'alert' : 'status'} className="text-[12px] text-fg-3">{error || 'Cargando firma…'}</p>}
  </div>
}
