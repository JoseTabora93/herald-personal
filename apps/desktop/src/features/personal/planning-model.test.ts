import {it,expect} from 'vitest'
import type {PersonalAgentObservation} from '../../../shared/personal.ts'
import {observationPresentation} from './planning-model.ts'

it('expires live evidence on the client even if a later refresh fails', () => {
  const row = { observed_at:'2026-10-09T12:00:00Z', stale_after_seconds:30, is_stale:false, effective_status:'active' } as PersonalAgentObservation
  expect(observationPresentation(row, Date.parse('2026-10-09T12:00:31Z')).freshness).toBe('Observación vencida')
})
