export type Block =
  | { kind: 'markdown'; text: string }
  | { kind: 'shell'; text: string; command: string }
  | { kind: 'mermaid'; source: string }
  | { kind: 'table'; source: string; rows: string[][] }

const FENCE = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g
const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell'])
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let last = 0
  for (const m of text.matchAll(FENCE)) {
    const start = m.index ?? 0
    pushProse(blocks, text.slice(last, start))
    const lang = (m[1] ?? '').toLowerCase()
    const body = (m[2] ?? '').trim()
    if (SHELL_LANGS.has(lang) && body) {
      blocks.push({ kind: 'shell', text: m[0], command: body })
    } else if (lang === 'mermaid' && body) {
      blocks.push({ kind: 'mermaid', source: body })
    } else {
      pushMarkdown(blocks, m[0])
    }
    last = start + m[0].length
  }
  pushProse(blocks, text.slice(last))

  return blocks
}

function pushMarkdown(blocks: Block[], text: string): void {
  if (!text.trim()) {
    return
  }
  const prev = blocks[blocks.length - 1]
  if (prev?.kind === 'markdown') {
    prev.text += text
  } else {
    blocks.push({ kind: 'markdown', text })
  }
}

function pushProse(blocks: Block[], text: string): void {
  const lines = text.split('\n')
  let prose: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (TABLE_ROW.test(lines[i]!) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      let end = i + 2
      while (end < lines.length && TABLE_ROW.test(lines[end]!)) {
        end++
      }
      pushMarkdown(blocks, prose.join('\n') + '\n')
      prose = []
      const table = lines.slice(i, end)
      blocks.push({ kind: 'table', source: table.join('\n'), rows: [table[0]!, ...table.slice(2)].map(cells) })
      i = end - 1
    } else {
      prose.push(lines[i]!)
    }
  }
  pushMarkdown(blocks, prose.join('\n'))
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell =>
      cell
        .replace(/\\\|/g, '|')
        .replace(/\*\*|__|`/g, '')
        .trim(),
    )
}

function wrapCell(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest.length > width) {
      if (line) {
        out.push(line)
        line = ''
      }
      out.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    if (!line) {
      line = rest
    } else if (line.length + 1 + rest.length <= width) {
      line += ' ' + rest
    } else {
      out.push(line)
      line = rest
    }
  }
  if (line || out.length === 0) {
    out.push(line)
  }

  return out
}

export function drawTable(rows: string[][], width: number): { lines: string[]; headerLines: number } {
  const cols = Math.max(...rows.map(row => row.length))
  const grid = rows.map(row => Array.from({ length: cols }, (_, c) => row[c] ?? ''))
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...grid.map(row => row[c]!.length)))
  const room = width - (3 * cols + 1)
  while (widths.reduce((a, b) => a + b, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest]! <= 5) {
      break
    }
    widths[widest]!--
  }

  const rule = (l: string, m: string, r: string) => l + widths.map(w => '─'.repeat(w + 2)).join(m) + r
  const drawRow = (row: string[]) => {
    const wrapped = row.map((cell, c) => wrapCell(cell, widths[c]!))
    const height = Math.max(...wrapped.map(w => w.length))

    return Array.from(
      { length: height },
      (_, i) => '│' + wrapped.map((w, c) => ` ${(w[i] ?? '').padEnd(widths[c]!)} `).join('│') + '│',
    )
  }

  const header = drawRow(grid[0]!)
  const body = grid.slice(1).flatMap(drawRow)

  return {
    lines: [rule('┌', '┬', '┐'), ...header, rule('├', '┼', '┤'), ...body, rule('└', '┴', '┘')],
    headerLines: header.length,
  }
}

export function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }

  return (h >>> 0).toString(36)
}
