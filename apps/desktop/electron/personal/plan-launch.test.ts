import { describe, expect, it, vi } from 'vitest'
import { PlanLauncher } from './plan-launch.ts'

describe('scheduled plan activation', () => {
  it('waits for the renderer, then opens the saved plan exactly once', async () => {
    const show = vi.fn()
    const dispatch = vi.fn(async () => ({ result: { ok: true } }))
    const launch = new PlanLauncher(show, dispatch)
    launch.request(['Herald', '--personal-plan', '2026-10-08'])
    expect(show).not.toHaveBeenCalled()
    await launch.ready()
    expect(show).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith('personal.open', { tab: 'today' }, 'cli')
    await launch.ready()
    await launch.request(['Herald', '--personal-plan', '2026-10-08'])
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('handles a future second instance without generating a plan or running arbitrary commands', async () => {
    const dispatch = vi.fn(async () => ({}))
    const launch = new PlanLauncher(vi.fn(), dispatch)
    await launch.ready()
    await launch.request(['Herald'])
    await launch.request(['Herald', '--personal-plan', '2026-02-30'])
    expect(dispatch).not.toHaveBeenCalled()
    await launch.request(['Herald', '--personal-plan', '2026-10-09'])
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('stays bounded when the renderer rejects the opening request', async () => {
    const failed = vi.fn()
    const dispatch = vi.fn(async () => { throw new Error('private renderer detail') })
    const launch = new PlanLauncher(vi.fn(), dispatch, failed)
    await launch.ready()
    await launch.request(['Herald', '--personal-plan', '2026-10-08'])
    expect(failed).toHaveBeenCalledWith()
    await launch.ready()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
