import { beforeEach, expect, it, vi } from 'vitest'
import { personalCommands } from '../../commands/personal.ts'
import { defineCommands, resetCommands, runCommand } from '../../store/os-commands.ts'

const mock = vi.hoisted(() => ({ focus: vi.fn(), showPage: vi.fn(), openWeb: vi.fn(), loadProjects: vi.fn(), state: { projectsError: null as string | null, projects: [{ id: 'p', name: 'Fixture', items: [{ task: { id: 't', title: 'Fixture task' }, pr: { number: 16, url: 'https://github.com/example/fixture/pull/16' } }] }] } }))
vi.mock('../../store/personal.ts', () => ({ focusPersonal: mock.focus, $personal: { get: () => mock.state }, personal: mock }))
vi.mock('../../store/windows.ts', () => ({ showPage: mock.showPage }))
vi.mock('../../store/web-windows.ts', () => ({ openWebWindow: mock.openWeb }))

beforeEach(() => { vi.clearAllMocks(); resetCommands(); defineCommands(personalCommands); mock.state.projectsError = null })
it('selects a project and evidence card through native OS commands', async () => {
  expect((await runCommand('personal.project.select', { id: 'p', taskId: 't' }, { source: 'ui' })).ok).toBe(true)
  expect(mock.focus).toHaveBeenCalledWith({ tab: 'projects', projectId: 'p', projectItemId: 't' })
  expect(mock.showPage).toHaveBeenCalledWith('personal')
  expect((await runCommand('personal.project.select', { id: 'foreign' }, { source: 'ui' })).ok).toBe(false)
})
it('opens a linked PR inside Herald and rejects invented links', async () => {
  expect((await runCommand('personal.project.pr', { id: 'p', taskId: 't' }, { source: 'ui' })).ok).toBe(true)
  expect(mock.openWeb).toHaveBeenCalledWith('https://github.com/example/fixture/pull/16', { title: 'PR #16 · Fixture' })
  expect((await runCommand('personal.project.pr', { id: 'p', taskId: 'missing' }, { source: 'ui' })).ok).toBe(false)
})
it('reports a project refresh failure without claiming a source sync', async () => {
  mock.state.projectsError = 'Sin conexión'
  expect((await runCommand('personal.projects.refresh', {}, { source: 'ui' })).ok).toBe(false)
  expect(mock.loadProjects).toHaveBeenCalledOnce()
})
