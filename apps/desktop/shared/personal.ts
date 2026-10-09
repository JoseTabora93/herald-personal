/** Personal data is shared by the desktop and Hermes through one authenticated service. */
export type PersonalProvider = 'microsoft365' | 'gmail'
export type PersonalTaskStatus = 'inbox' | 'next' | 'in_progress' | 'waiting' | 'done' | 'cancelled'
export type PersonalPriority = 'low' | 'normal' | 'high'
export type PersonalMailCategory = 'urgent' | 'action' | 'waiting' | 'reference' | 'newsletter'

export interface PersonalTask {
  id: string
  title: string
  description: string | null
  status: PersonalTaskStatus
  priority: PersonalPriority
  due_at: string | null
  source_type: 'manual' | 'mail' | 'whatsapp' | 'agent'
  source_id: string | null
  project: string | null
  agent_task_id: string | null
  created_at: string
  updated_at: string
  revision: number
}

export interface PersonalMailThread {
  id: string
  provider: PersonalProvider
  subject: string
  sender: string
  preview: string
  body: string
  received_at: string
  category: PersonalMailCategory
  unread: boolean
  web_url: string | null
  task_id: string | null
  archived: boolean
}

export interface PersonalCheckin {
  id: string
  date: string
  accomplished: string
  pending: string
  tomorrow: string
  created_at: string
  updated_at: string
}

export interface PersonalProviderStatus {
  provider: PersonalProvider
  configured: boolean
  connected: boolean
  last_sync_at: string | null
  error: string | null
}

export interface PersonalMailPage {
  items: PersonalMailThread[]
  providers: PersonalProviderStatus[]
  total: number
  offset: number
  next_offset: number | null
}

export interface PersonalStatus {
  version: string
  timezone: string
  providers: PersonalProviderStatus[]
  mail_source?: 'workspace' | 'basic'
  mail_workspace?: PersonalMailWorkspaceStatus | null
  capabilities: { mail_read: boolean; mail_draft: boolean; mail_archive: boolean; agent_supervision: boolean }
}

export interface PersonalOverview {
  timezone: string
  as_of: string
  counts: { open: number; overdue: number; urgent_mail: number | null; waiting_review: number }
  priorities: PersonalTask[]
  recent_checkins: PersonalCheckin[]
  providers: PersonalProviderStatus[]
  mail_source?: 'workspace' | 'basic'
  mail_workspace?: PersonalMailWorkspaceStatus | null
}

export interface PersonalRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  path: string
  body?: unknown
}

export interface PersonalEvent { id: string; kind: string; created_at: string; detail: string }
export interface PersonalBrief { text: string; generated_at: string; source_ids: string[] }

export type PersonalAgentRunStatus = 'queued' | 'running' | 'cancel_requested' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted'
export interface PersonalAgentAttempt {
  number: number
  status: PersonalAgentRunStatus
  started_at: string
  finished_at: string | null
  exit_code: number | null
  stdout_sha256: string | null
  stderr_sha256: string | null
  outcome: string | null
}
export interface PersonalAgentRun {
  run_id: string
  revision: number
  scope_id: string
  task_id: string | null
  workspace: string
  agent: 'claude' | 'opencode'
  status: PersonalAgentRunStatus
  created_at: string
  updated_at: string
  verification: 'not_run'
  attempts: PersonalAgentAttempt[]
}

export interface PersonalMailWorkspaceStatus {
  configured: boolean
  reachable: boolean
  base_url: string | null
  error: string | null
  counts: Record<string, unknown> | null
}

export type PersonalObservationStatus = 'active' | 'idle' | 'waiting_permission' | 'waiting_input' | 'retrying' | 'error' | 'ended' | 'unknown'
export interface PersonalAgentObservation {
  observer_id: string
  revision: number
  observed_at: string
  agent: 'claude' | 'opencode'
  native_session_id: string
  workspace: string
  status: PersonalObservationStatus
  effective_status: PersonalObservationStatus
  evidence_source: string
  confidence: 'high' | 'medium' | 'low'
  source_updated_at: string | null
  stale_after_seconds: number
  signals: string[]
  verification: 'not_run'
  is_stale: boolean
}

export interface PersonalDailyPlan {
  date: string
  timezone: string
  revision: number
  generated_at: string
  updated_at: string
  status: 'ready' | 'partial'
  summary: string
  priorities: { id: string; title: string; reason: string; source_ref: string; kind: 'task' | 'mail' | 'agent' }[]
  recommendations: { title: string; reason: string; evidence_refs: string[]; author: 'rules' | 'hermes' }[]
  sources: { id: string; kind: string; status: 'available' | 'unavailable' | 'stale'; as_of: string | null; description: string }[]
  mail_summary: { available: boolean; last_sync_at: string | null; window_days: number | null; total: number; needs_reply: number; waiting_reply: number; unclassified: number }
  agent_summary: { active: number; attention: number; unknown: number }
  limitations: string[]
  model: string | null
  model_error: 'not_configured' | 'timeout' | 'invalid_response' | 'provider_error' | null
  verification: 'not_run'
}
