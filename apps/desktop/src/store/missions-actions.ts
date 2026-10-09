import { createChat, sendPromptInBackground } from './chat.ts'
import { showPage } from './windows.ts'

const TITLE_MAX = 60

/** The prompt shape that makes a chat a mission (todo list first, then work, then a summary). */
export function missionPrompt(goal: string): string {
  return `Mission: ${goal}\n\nPlan this as a mission: first create a todo list of the concrete steps with the todo tool, then work through them, updating the todo list as you go, and finish with a short summary of what you produced.`
}

/** Start a mission in a fresh session and show it. Shared by the composer, the palette and voice. */
export async function startMission(goal: string): Promise<{ sessionId: string; title: string }> {
  const trimmed = goal.trim()

  if (!trimmed) {
    throw new Error('A mission needs a goal.')
  }

  const title = trimmed.slice(0, TITLE_MAX)
  const chat = await createChat({ title })
  void sendPromptInBackground(missionPrompt(trimmed), { sessionId: chat.sessionId })
  showPage('hermes')

  return { sessionId: chat.sessionId, title }
}
