import type { EngineInterface } from 'claude-code'

import { agendaParts } from './agenda'

export async function writeFooter($: EngineInterface, buttonWidth: number, isCompact: boolean): Promise<void> {
  try {
    const path = `${$.plugin.root}/../../cache/activity-footer/${await $.session.id()}.json`
    await $.fs.write(path, JSON.stringify({ calendar: await agendaParts($), buttonWidth, isCompact, at: Date.now() }))
  } catch {
    return
  }
}
