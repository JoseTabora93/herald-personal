import { describe, expect, it } from 'vitest'
import { buildTaskCreate, buildTaskPatch, dateLabel, dateToDueAt, dueDateInput, errorMessage, isOpenTask, localDate, providerLabel, safeMailUrl, taskEventPresentation, taskForm, type TaskForm } from './model.ts'

const task = {
  id: 'task-1', title: 'Preparar propuesta', description: null, status: 'next' as const,
  priority: 'high' as const, due_at: '2026-10-08T06:00:00.000Z', source_type: 'manual' as const,
  source_id: null, project: 'BAC', agent_task_id: null,
  created_at: '2026-10-07T18:00:00Z', updated_at: '2026-10-07T18:00:00Z', revision: 4
}

describe('personal calendar dates', () => {
  it('uses the Tegucigalpa calendar day, even after UTC midnight', () => {
    expect(localDate('2026-10-09T02:30:00Z')).toBe('2026-10-08')
  })

  it('preserves date-only semantics so the service applies the end of the local day', () => {
    expect(dateToDueAt('2026-10-08')).toBe('2026-10-08')
    expect(dueDateInput(dateToDueAt('2026-10-08'))).toBe('2026-10-08')
    expect(dueDateInput('2026-10-09T05:59:59Z')).toBe('2026-10-08')
  })

  it('keeps no deadline empty and rejects impossible calendar dates', () => {
    expect(dateToDueAt('')).toBeNull()
    expect(dueDateInput(null)).toBe('')
    expect(() => dateToDueAt('2026-02-30')).toThrow(/fecha/i)
    expect(() => dateToDueAt('08/10/2026')).toThrow(/fecha/i)
  })
})

describe('commitment form writes', () => {
  it('reopens all editable values without changing the revision', () => {
    expect(taskForm(task)).toEqual({ title: 'Preparar propuesta', description: '', status: 'next', priority: 'high', dueDate: '2026-10-08', project: 'BAC' })
    expect(task.revision).toBe(4)
  })

  it('keeps the same idempotency key for retries and normalizes empty fields', () => {
    const form = { ...taskForm(), title: '  Llamar a compras  ' }
    const first = buildTaskCreate(form, 'stable-form-id')
    expect(first).toEqual(buildTaskCreate(form, 'stable-form-id'))
    expect(first).toMatchObject({ title: 'Llamar a compras', description: null, project: null, due_at: null, idempotency_key: 'stable-form-id', source_type: 'manual' })
  })

  it('sends the revision the user actually edited, so concurrent changes cannot be overwritten', () => {
    const patch = buildTaskPatch({ ...taskForm(task), title: 'Revisar propuesta' }, task.revision)
    expect(patch).toMatchObject({ title: 'Revisar propuesta', expected_revision: 4 })
  })

  it('rejects blank or oversized titles before making a request', () => {
    expect(() => buildTaskCreate({ ...taskForm(), title: '  ' }, 'key')).toThrow(/título/i)
    expect(() => buildTaskPatch({ ...taskForm(), title: 'x'.repeat(501) }, 2)).toThrow(/título/i)
  })

  it('preserves an existing precise deadline when editing an unrelated field', () => {
    const exactDeadline = '2026-10-08T20:30:00Z'
    expect(buildTaskPatch({ ...taskForm(task), title: 'Título nuevo' }, 4, exactDeadline).due_at).toBe(exactDeadline)
    expect(buildTaskPatch({ ...taskForm(task), dueDate: '2026-10-10' }, 4, exactDeadline).due_at).toBe('2026-10-10')
  })

  it('requires a safe revision and a stable create identity, rejecting unknown choices', () => {
    expect(() => buildTaskCreate(taskForm(task), '')).toThrow(/referencia/i)
    expect(() => buildTaskPatch(taskForm(task), 0)).toThrow(/recarga/i)
    expect(() => buildTaskPatch(taskForm(task), 1.5)).toThrow(/recarga/i)
    expect(() => buildTaskCreate({ ...taskForm(task), status: 'invalid' } as unknown as TaskForm, 'key')).toThrow(/estado/i)
    expect(() => buildTaskCreate({ ...taskForm(task), priority: 'invalid' } as unknown as TaskForm, 'key')).toThrow(/prioridad/i)
  })
})

describe('connection and external link presentation', () => {
  it('keeps the actionable service message without exposing Electron transport details', () => {
    expect(errorMessage(new Error("Error invoking remote method 'herald-os:personal:request': Error: 409: El registro cambió. Actualiza antes de continuar."))).toBe('El registro cambió. Actualiza antes de continuar.')
  })
  it('distinguishes missing setup, provider errors and a verified connection', () => {
    expect(providerLabel({ provider: 'gmail', configured: false, connected: false, last_sync_at: null, error: null })).toBe('Sin configurar')
    expect(providerLabel({ provider: 'gmail', configured: true, connected: false, last_sync_at: null, error: 'unavailable' })).toBe('Requiere atención')
    expect(providerLabel({ provider: 'gmail', configured: true, connected: true, last_sync_at: null, error: null })).toBe('Conectado')
    expect(providerLabel({ provider: 'gmail', configured: true, connected: false, last_sync_at: null, error: null })).toBe('Sin conexión')
  })

  it('permits only HTTPS provider links from mail data', () => {
    expect(safeMailUrl('https://outlook.office.com/mail/id/1')).toBe('https://outlook.office.com/mail/id/1')
    expect(safeMailUrl('https://mail.google.com/mail/u/0/#inbox/a')).toContain('mail.google.com')
    expect(safeMailUrl('javascript:alert(1)')).toBeNull()
    expect(safeMailUrl('https://mail.google.com.attacker.test/')).toBeNull()
    expect(safeMailUrl('https://attacker.test/')).toBeNull()
    expect(safeMailUrl('not a url')).toBeNull()
    expect(safeMailUrl(null)).toBeNull()
    expect(safeMailUrl('https://someone:password@mail.google.com/')).toBeNull()
    expect(safeMailUrl('http://mail.google.com/')).toBeNull()
  })

  it('shows useful Spanish fallbacks and the local date in labels', () => {
    expect(dateLabel(null)).toBe('Sin fecha')
    expect(dateLabel('invalid')).toBe('Fecha no disponible')
    expect(dateLabel('2026-10-08')).toMatch(/^8/)
    expect(dateLabel('2026-10-09T02:00:00Z', true)).toContain('8')
    expect(errorMessage(new Error('sin conexión'))).toBe('sin conexión')
    expect(errorMessage({ private: 'do not display' })).toBe('No se pudo completar la operación.')
    expect(isOpenTask(task)).toBe(true)
    expect(isOpenTask({ ...task, status: 'done' })).toBe(false)
    expect(isOpenTask({ ...task, status: 'cancelled' })).toBe(false)
  })
})

describe('readable commitment history', () => {
  it('summarizes changed fields and status without dumping before/after records', () => {
    const event = { kind: 'updated', detail: JSON.stringify({ before: { title: 'Anterior', status: 'next', priority: 'high', due_at: null }, after: { title: 'Nuevo', status: 'waiting', priority: 'high', due_at: '2026-10-13T05:59:59Z' }, revision: 4 }) }
    expect(taskEventPresentation(event)).toEqual({ label: 'Actualizado', detail: 'Estado: En espera. Cambios: título, fecha límite. Revisión 4.' })
  })

  it('describes the source of a captured commitment in Spanish', () => {
    expect(taskEventPresentation({ kind: 'created', detail: JSON.stringify({ title: 'Propuesta', source_type: 'mail' }) })).toEqual({ label: 'Creado', detail: 'Capturado desde un correo.' })
  })

  it('uses a stable fallback for unknown or malformed audit payloads', () => {
    for (const detail of ['{invalid', 'null', '[]', '{"unexpected":"raw private record"}']) {
      expect(taskEventPresentation({ kind: 'internal.unknown', detail })).toEqual({ label: 'Actividad registrada', detail: 'El servicio guardó un cambio en este compromiso.' })
    }
  })
})
