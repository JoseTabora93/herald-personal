import { personalPlanRequest } from './mail-view.ts'

/** The explicit scheduled flag selects the saved plan only after the shell is ready. */
export class PlanLauncher {
  private pending: string | null = null
  private isReady = false
  private readonly opened = new Set<string>()

  constructor(
    private readonly show: () => void,
    private readonly dispatch: (command: string, args: Record<string, unknown>, source: 'cli') => Promise<{ error?: string; result?: unknown }>,
    private readonly failed: () => void = () => undefined
  ) {}

  request(argv: string[]): Promise<void> {
    const request = personalPlanRequest(argv)
    if (request && !this.opened.has(request.date)) this.pending = request.date
    return this.flush()
  }

  ready(): Promise<void> {
    this.isReady = true
    return this.flush()
  }

  private async flush(): Promise<void> {
    if (!this.isReady || !this.pending) return
    const date = this.pending
    this.pending = null
    this.opened.add(date)
    try {
      this.show()
      const reply = await this.dispatch('personal.open', { tab: 'today' }, 'cli')
      if (reply.error) this.failed()
    } catch { this.failed() }
  }
}
