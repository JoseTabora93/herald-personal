import { describe, expect, it } from 'vitest'
import type { PersonalProject } from '../../../shared/personal.ts'
import { projectPresentation, safeProjectPr } from './projects-model.ts'

describe('project evidence presentation', () => {
  it('expires a cached running signal even when the API stops responding', () => {
    const now = Date.parse('2026-10-10T14:00:00Z')
    const source = { id: 's', label: 'Fixture', health: 'ok', last_attempt_at: '2026-10-10T12:00:00Z', interval_seconds: 900, run_fresh: true }
    const project = { counts: { total: 1, running: 1, closed: 0, attention: 0, review: 0, merged: 0 }, sources: [source], items: [{ source_id: 's', stage: 'running', source_updated_at: '2026-10-10T12:00:00Z' }] } as PersonalProject
    const result = projectPresentation(project, now)
    expect(result.sources[0].health).toBe('stale')
    expect(result.items[0].stage).toBe('unknown')
    expect(result.counts.running).toBe(0)
    expect(result.counts.attention).toBe(1)
    expect(project.counts.running).toBe(1)
  })
  it.each(['https://github.com.evil.test/a/b/pull/1', 'javascript:alert(1)', 'https://secret@github.com/a/b/pull/1', 'https://github.com/a/b/pull/1?token=secret'])('rejects unsafe PR target %s', value => {
    expect(safeProjectPr(value)).toBeNull()
  })
  it('allows only an exact GitHub pull request URL', () => {
    expect(safeProjectPr('https://github.com/example/fixture/pull/16')).toBe('https://github.com/example/fixture/pull/16')
  })
})
