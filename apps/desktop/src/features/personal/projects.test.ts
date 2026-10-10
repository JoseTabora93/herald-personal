import { describe, expect, it, vi } from 'vitest'
import { createPersonalController, type PersonalTransport } from './controller.ts'

describe('project dashboard snapshots', () => {
  it('reads all project stages through the shared service, including closed work', async () => {
    const item = { id: 'project-1', name: 'Fixture', counts: { total: 6, closed: 5 }, items: [] }
    const request = vi.fn<PersonalTransport>().mockResolvedValue({ items: [item], as_of: '2026-10-10T14:00:00Z' })
    const controller = createPersonalController(request)
    await controller.loadProjects()
    expect(request).toHaveBeenCalledExactlyOnceWith({ method: 'GET', path: '/v1/projects' })
    expect(controller.state.get()).toMatchObject({ projects: [item], projectsError: null, projectsLoading: false })
  })

  it('retains the last project snapshot with a visible error on disconnect', async () => {
    const request = vi.fn<PersonalTransport>().mockResolvedValueOnce({ items: [{ id: 'p', name: 'Fixture' }] }).mockRejectedValueOnce(new Error('Sin conexión'))
    const controller = createPersonalController(request)
    await controller.loadProjects()
    await controller.loadProjects()
    expect(controller.state.get()).toMatchObject({ projects: [{ id: 'p', name: 'Fixture' }], projectsError: 'Sin conexión', projectsLoading: false })
  })

  it('ignores an older refresh that finishes after the newer snapshot', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn<PersonalTransport>().mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValueOnce({ items: [{ id: 'new' }] })
    const controller = createPersonalController(request)
    const old = controller.loadProjects()
    await controller.loadProjects()
    finish({ items: [{ id: 'old' }] })
    await old
    expect(controller.state.get().projects).toEqual([{ id: 'new' }])
  })
})
