import type { EngineInterface } from 'claude-code'

const CONTEXT = 3
const MAX_WRITE_LINES = 500

type Pair = { before: string; after: string }

function pairsOf(input: Record<string, unknown>): Pair[] {
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input]

  return edits.map(one => ({ before: String(one.old_string ?? ''), after: String(one.new_string ?? one.new_source ?? '') }))
}

function split(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n')
}

function hunk(start: number, context: string[], removed: string[], added: string[], trailing: string[]): string {
  const header = `@@ -${start},${context.length + removed.length + trailing.length} +${start},${context.length + added.length + trailing.length} @@`
  const body = [...context.map(l => ` ${l}`), ...removed.map(l => `-${l}`), ...added.map(l => `+${l}`), ...trailing.map(l => ` ${l}`)]

  return [header, ...body].join('\n')
}

function placedHunk(file: string, pair: Pair): string | null {
  const at = pair.after ? file.indexOf(pair.after) : -1
  if (at < 0) {
    return null
  }
  const lineStart = file.lastIndexOf('\n', at - 1) + 1
  const end = at + pair.after.length
  const nextBreak = file.indexOf('\n', Math.max(end - 1, at))
  const lineEnd = nextBreak < 0 ? file.length : nextBreak
  const prefix = file.slice(lineStart, at)
  const suffix = file.slice(end, lineEnd)
  const lines = file.split('\n')
  const first = file.slice(0, lineStart).split('\n').length - 1
  const added = split(file.slice(lineStart, lineEnd))
  const removed = split(prefix + pair.before + suffix)
  const context = lines.slice(Math.max(0, first - CONTEXT), first)
  const trailing = lines.slice(first + added.length, first + added.length + CONTEXT)

  return hunk(first - context.length + 1, context, removed, added, trailing)
}

function loneHunk(pair: Pair): string {
  return hunk(1, [], split(pair.before), split(pair.after), [])
}

export async function buildDiff($: EngineInterface, tool: string, path: string, input: Record<string, unknown>): Promise<string> {
  if (typeof input.content === 'string') {
    const lines = split(input.content).slice(0, MAX_WRITE_LINES)

    return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n')
  }
  const file = tool === 'NotebookEdit' ? null : ((await $.fs.read(path).catch(() => null)) as string | null)

  return pairsOf(input)
    .map(pair => (typeof file === 'string' ? placedHunk(file, pair) : null) ?? loneHunk(pair))
    .join('\n')
}
