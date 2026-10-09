import { IconPaperclip, IconPlayerStop, IconSend2 } from '@tabler/icons-react'
import { useStore } from '@nanostores/react'
import { $chatDrafts, EMPTY_DRAFT, setChatDraft, submitChatDraft } from '../../store/chat-drafts.ts'
import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn.ts'
import { MicButton } from '../voice/MicButton.tsx'

/*
 * The Hermes page composer. Same behaviour as chat/Composer.tsx (Enter sends, Shift+Enter breaks
 * a line, Stop while streaming) with the mockup's chrome: paperclip, mic, blue send. Slash
 * completions are intentionally left to the classic chat surface.
 */
export function HermesComposer({ draftKey = 'new', disabled, streaming, placeholder, autoFocus, onSubmit, onInterrupt, className }: { draftKey?: string; disabled?: boolean; streaming?: boolean; placeholder?: string; autoFocus?: boolean; onSubmit: (text: string) => void | string | Promise<void | string>; onInterrupt?: () => void; className?: string }) {
  const draft = useStore($chatDrafts)[draftKey] ?? EMPTY_DRAFT
  const value = draft.text
  const setValue = (text: string) => setChatDraft(draftKey, text)
  const textarea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textarea.current

    if (!el) {
      return
    }

    el.style.height = '0px'
    el.style.height = `${Math.min(200, Math.max(24, el.scrollHeight))}px`
  }, [value])

  const submit = () => {
    if (!disabled && !streaming) void submitChatDraft(draftKey, onSubmit)
  }

  const attach = async () => {
    const paths = await window.heraldOS.fs.pickFiles({ multiple: true })

    if (paths.length === 0) {
      return
    }

    const line = `Attached: ${paths.join(', ')}`
    const current = $chatDrafts.get()[draftKey]?.text ?? ''
    setValue(current.trim() ? `${current.replace(/\s+$/, '')}\n${line}` : line)
    textarea.current?.focus()
  }

  return (
    <div>
      {draft.error && <p role="alert" className="mb-2 text-[12px] text-danger">{draft.error} Tu borrador sigue aquí.</p>}
    <div className={cn('glass-input flex items-end gap-2 rounded-xl px-2.5 py-2', className)}>
      <button type="button" aria-label="Adjuntar archivos" disabled={disabled || draft.sending} onClick={() => void attach()} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-40">
        <IconPaperclip size={17} stroke={1.7} />
      </button>
      <textarea
        ref={textarea}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled || draft.sending}
        rows={1}
        placeholder={placeholder ?? 'Ask Hermes anything…'}
        aria-label="Mensaje para Hermes"
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
        className="max-h-[200px] min-h-6 flex-1 resize-none bg-transparent py-1 text-[13.5px] leading-6 outline-none placeholder:text-fg-4 disabled:opacity-50"
      />
      <MicButton size={17} className="size-8" disabled={disabled || draft.sending} />
      {streaming && onInterrupt ? (
        <button type="button" aria-label="Detener respuesta" onClick={onInterrupt} className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-danger/40 bg-danger/15 text-danger hover:bg-danger/25">
          <IconPlayerStop size={15} />
        </button>
      ) : (
        <button
          type="button"
          aria-label="Enviar mensaje"
          disabled={disabled || draft.sending || streaming || !value.trim()}
          onClick={() => void submit()}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-accent-strong/60 bg-accent text-accent-fg shadow-[0_4px_14px_rgba(47,125,255,.45)] transition-colors duration-120 hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
        >
          <IconSend2 size={16} stroke={1.8} />
        </button>
      )}
    </div>
    </div>
  )
}
