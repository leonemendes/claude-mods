export type Tag = 'code' | 'review' | 'data' | 'meeting' | 'research' | 'general'

declare module 'claude-code' {
  interface PluginState {
    'job-tags': { tag: Tag | null; pending: boolean; title: string | null; renaming: boolean }
  }
}
