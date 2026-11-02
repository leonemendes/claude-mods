export type FileEdit = {
  id: string
  path: string
  tool: string
  diff: string
}

export type PullRequest = { owner: string; repo: string; number: number }

export type Run = {
  status: 'running' | 'done' | 'failed'
  output: string
  command?: string
  exitCode?: number
  sent?: boolean
}

export type Drawing = { isDrawn: boolean; text: string }

export type Meeting = { id: string; title: string; start: string; end: string; url: string | null }

export type Agenda = { meetings: Meeting[]; error: string | null; fetchedAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    'activity-pane': { edits: FileEdit[]; selected: string | null; runs: Record<string, Run>; prs: PullRequest[]; drawings: Record<string, Drawing>; agenda: Agenda; now: number }
  }
}
