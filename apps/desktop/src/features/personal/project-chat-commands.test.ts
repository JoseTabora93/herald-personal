import { atom } from 'nanostores'
import { beforeEach, expect, it, vi } from 'vitest'
import { personalCommands } from '../../commands/personal.ts'
import { defineCommands, resetCommands, runCommand } from '../../store/os-commands.ts'

const io = vi.hoisted(() => ({ send: vi.fn(), select: vi.fn(), stop: vi.fn(), open: vi.fn(), draft: vi.fn(), focus: vi.fn(), show: vi.fn(), project: { id: 'p', name: 'Fixture', items: [{ task: { id: 't', title: 'Trabajo' } }] } }))
vi.mock('../../store/project-chat.ts', () => ({ $projectChatOpen: atom(false), projectChats: { send: io.send, select: io.select, interrupt: io.stop, open: io.open, state: { get: () => ({}) } }, projectDraftKey: () => 'project:p:new' }))
vi.mock('../../store/chat-drafts.ts', () => ({ setChatDraft: io.draft }))
vi.mock('../../store/personal.ts', () => ({ $personal: { get: () => ({ projects: [io.project] }) }, focusPersonal: io.focus }))
vi.mock('../../store/windows.ts', () => ({ showPage: io.show }))
vi.mock('../../store/web-windows.ts', () => ({ openWebWindow: vi.fn() }))

beforeEach(() => { vi.clearAllMocks(); resetCommands(); defineCommands(personalCommands) })
it('opens a project chat and prepares a suggestion without submitting a prompt', async () => {
  expect((await runCommand('personal.project.chat.open', { id: 'p' }, { source: 'ui' })).ok).toBe(true)
  expect(io.focus).toHaveBeenCalledWith({ tab: 'projects', projectId: 'p' })
  expect((await runCommand('personal.project.chat.suggest', { id: 'p', text: 'Guíame' }, { source: 'ui' })).ok).toBe(true)
  expect(io.draft).toHaveBeenCalledWith('project:p:new', 'Guíame')
  expect(io.send).not.toHaveBeenCalled()
})
it('submits and stops the exact project, exposes failures, rejects unknown projects', async () => {
  expect((await runCommand('personal.project.chat.send', { id: 'p', text: 'Nuevo rumbo' }, { source: 'ui' })).ok).toBe(true)
  expect(io.send).toHaveBeenCalledWith('p', 'Nuevo rumbo')
  expect((await runCommand('personal.project.chat.stop', { id: 'p' }, { source: 'ui' })).ok).toBe(true)
  expect(io.stop).toHaveBeenCalledWith('p')
  io.send.mockRejectedValueOnce(new Error('Sin conexión'))
  expect((await runCommand('personal.project.chat.send', { id: 'p', text: 'Nuevo rumbo' }, { source: 'ui' })).ok).toBe(false)
  expect((await runCommand('personal.project.chat.send', { id: 'foreign', text: 'X' }, { source: 'ui' })).ok).toBe(false)
})
it('resumes, starts blank, refreshes and minimizes without model prompts', async () => {
  expect((await runCommand('personal.project.chat.select', { id: 'p', sessionId: 'saved' }, { source: 'ui' })).ok).toBe(true)
  expect(io.select).toHaveBeenLastCalledWith('p', 'saved')
  expect((await runCommand('personal.project.chat.select', { id: 'p' }, { source: 'ui' })).ok).toBe(true)
  expect(io.select).toHaveBeenLastCalledWith('p', null)
  expect((await runCommand('personal.project.chat.refresh', { id: 'p' }, { source: 'ui' })).ok).toBe(true)
  expect(io.open).toHaveBeenCalledWith('p')
  expect((await runCommand('personal.project.chat.close', {}, { source: 'ui' })).ok).toBe(true)
  expect(io.send).not.toHaveBeenCalled()
  expect((await runCommand('personal.project.chat.send', { id: 'p', text: '  ' }, { source: 'ui' })).ok).toBe(false)
  expect((await runCommand('personal.project.chat.send', { id: 'p', text: 'x'.repeat(20001) }, { source: 'ui' })).ok).toBe(false)
})
