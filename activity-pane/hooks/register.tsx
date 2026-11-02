import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileEdit, PullRequest, Run } from '../types'

import { refreshAgenda, tickNow } from './agenda'
import { drawTable, hash, parseBlocks } from './blocks'
import { buildDiff } from './diff'
import type { Block } from './blocks'
import { writeFooter } from './footer'

const PANE = 'activity'
const TITLE = 'Files'
const KEEP = 200
const BACK = 'back'
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

const edits = atom({ plugin: 'activity-pane', key: 'edits' } as const, [])
const selected = atom({ plugin: 'activity-pane', key: 'selected' } as const, null)
const runs = atom({ plugin: 'activity-pane', key: 'runs' } as const, {})
const prs = atom({ plugin: 'activity-pane', key: 'prs' } as const, [])
const drawings = atom({ plugin: 'activity-pane', key: 'drawings' } as const, {})

const PR_LINK = /(?:github\.com\/([\w.-]+)\/([\w.-]+)\/pull|app\.graphite\.(?:com|dev)\/github\/pr\/([\w.-]+)\/([\w.-]+))\/(\d+)/g

function findPrs(text: string): PullRequest[] {
  return [...text.matchAll(PR_LINK)].map(m => ({ owner: m[1] ?? m[3]!, repo: m[2] ?? m[4]!, number: Number(m[5]) }))
}

async function notePrs($: EngineInterface, text: string): Promise<void> {
  const found = findPrs(text)
  if (found.length === 0) {
    return
  }
  await update($, prs, list => {
    const known = new Set(list.map(prKey))
    const fresh: PullRequest[] = []
    for (const pr of found) {
      if (!known.has(prKey(pr))) {
        known.add(prKey(pr))
        fresh.push(pr)
      }
    }

    return fresh.length > 0 ? [...list, ...fresh] : list
  })
}

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/
const GT = /(^|[\s;&|(])gt\s/

function createdPrText(command: string, output: string): string {
  if (GH_PR_CREATE.test(command)) {
    return output
  }
  if (GT.test(command)) {
    return output.split('\n').filter(line => /\(created\)\s*$/.test(line)).join('\n')
  }

  return ''
}

function prKey(pr: PullRequest): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase()
}

function graphiteUrl(pr: PullRequest): string {
  return `https://app.graphite.com/github/pr/${pr.owner}/${pr.repo}/${pr.number}`
}

const RUN_TIMEOUT_MS = 120_000
const OUTPUT_CHARS = 20_000
const OUTPUT_LINES = 15
const MERMAID_TIMEOUT_MS = 20_000
const drawing = new Set<string>()

async function drawMermaid($: EngineInterface, key: string, source: string, width: number): Promise<void> {
  if (drawing.has(key)) {
    return
  }
  drawing.add(key)
  let result = { isDrawn: false, text: '' }
  try {
    const ran = await $.process.run(['/bin/zsh', '-lc', `mermaid-ascii -f - --max-width ${width}`], { stdin: source, timeoutMs: MERMAID_TIMEOUT_MS })
    result = ran.exitCode === 0 && ran.stdout.trim()
      ? { isDrawn: true, text: ran.stdout.replace(/\s+$/, '') }
      : { isDrawn: false, text: (ran.stderr || ran.stdout || `exit ${ran.exitCode}`).trim().split('\n')[0]! }
  } catch (error) {
    result = { isDrawn: false, text: String(error) }
  }
  await update($, drawings, all => ({ ...all, [key]: result }))
}

async function copy($: EngineInterface, text: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']): Promise<void> {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? 'Copied' : 'Could not copy')
}

function capOutput(output: string): string {
  return output.length > OUTPUT_CHARS ? `${output.slice(0, OUTPUT_CHARS)}\n… (${output.length - OUTPUT_CHARS} more chars cut)` : output
}

async function runCommand($: EngineInterface, id: string, cmd: string, send = false): Promise<void> {
  await update($, runs, all => ({ ...all, [id]: { status: 'running' as const, output: '', command: cmd } }))
  let run: Run
  try {
    const ran = await $.process.run(['/bin/zsh', '-lc', cmd], { cwd: await $.session.cwd(), timeoutMs: RUN_TIMEOUT_MS })
    const output = [ran.stdout, ran.stderr].filter(Boolean).join('\n') || '(no output)'
    run = { status: ran.exitCode === 0 ? 'done' : 'failed', output: capOutput(output), command: cmd, exitCode: ran.exitCode }
  } catch (error) {
    run = { status: 'failed', output: `Could not run: ${String(error)}`, command: cmd }
  }
  await update($, runs, all => ({ ...all, [id]: run }))
  if (send) {
    await sendRun($, id, cmd)
  }
}

function runMessage(run: Run, cmd: string): string {
  const exit = run.exitCode === undefined ? 'it did not start' : `exit ${run.exitCode}`
  const fence = run.output.includes('```') ? '````' : '```'

  return `I ran this command from your reply (${exit}):\n\n\`\`\`bash\n${cmd}\n\`\`\`\n\nOutput:\n\n${fence}\n${run.output}\n${fence}`
}

async function sendRun($: EngineInterface, id: string, cmd: string): Promise<void> {
  const run = (await read($, runs))[id]
  if (!run || run.status === 'running' || run.sent) {
    return
  }
  await update($, runs, all => ({ ...all, [id]: { ...run, sent: true } }))
  try {
    await $.prompt.submit({ text: runMessage(run, run.command ?? cmd) })
  } catch (error) {
    await update($, runs, all => ({ ...all, [id]: { ...run, sent: false } }))
    $.ui.toast(`Could not send to Claude: ${String(error)}`)
  }
}

const AGENDA_REFRESH_MS = 5 * 60_000
const TICK_MS = 60_000
const LARGEST = { rows: 1000, columns: 1000 }
const SHORTCUT_HINT = /^\([^)]*\)\s*(·\s*)?/

async function filesLabel($: EngineInterface): Promise<string> {
  const files = new Set((await read($, edits)).map(one => one.path)).size
  const pulls = (await read($, prs)).length
  const counts = [files > 0 ? `Files ${files}` : 'Files', ...(pulls > 0 ? [`PRs ${pulls}`] : [])]

  return `${counts.join(' · ')} ›`
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes().catch(() => [])).some(one => one.id === PANE && one.isShown)
}

async function syncFooter($: EngineInterface): Promise<void> {
  await writeFooter($, (await filesLabel($)).length, await isPaneShown($))
}

async function togglePane($: EngineInterface): Promise<void> {
  if (await isPaneShown($)) {
    await $.ui.close({ id: PANE })
  } else {
    await $.ui.open({ id: PANE, title: TITLE, focus: true, ...LARGEST })
  }
  await syncFooter($)
}

async function openFile($: EngineInterface, path: string): Promise<void> {
  await update($, selected, () => path)
  void $.ui.focus({ requestId: PANE, key: BACK }).catch(() => undefined)
}

async function closeFile($: EngineInterface, path: string): Promise<void> {
  await update($, selected, () => null)
  void $.ui.focus({ requestId: PANE, key: `file:${path}` }).catch(() => undefined)
}

const RUN_MARK: Record<Run['status'], string> = { running: '…', done: '✓', failed: '✗' }

function clip(text: string, width: number): string {
  return text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text
}

function diffSource(edit: FileEdit): string {
  if (typeof edit.diff === 'string' && edit.diff) {
    return edit.diff
  }
  const legacy = ((edit as unknown as { lines?: { kind: string; text: string }[] }).lines ?? []).filter(line => line.kind !== ' ')
  const removed = legacy.filter(line => line.kind === '-').length

  return [`@@ -1,${removed} +1,${legacy.length - removed} @@`, ...legacy.map(line => `${line.kind}${line.text}`)].join('\n')
}

function shortPath(path: string, cwd: string): string {
  return path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'activity', description: 'Open the Files pane: files Claude changed, click one for its diff' })
    void refreshAgenda($, () => syncFooter($))
    $.clock.every(AGENDA_REFRESH_MS, () => refreshAgenda($, () => syncFooter($)))
    $.clock.every(TICK_MS, () => tickNow($).then(() => syncFooter($)))

    return next(e)
  })

  on('command.run', { command: 'activity' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, ...LARGEST })
    await syncFooter($)

    return { text: 'Files pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      await syncFooter($)
    }

    return closed
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Bash' && ran.deny === undefined) {
      await notePrs($, createdPrText(e.command, ran.text ?? ''))
      await syncFooter($)
    }
    const input = e as unknown as Record<string, unknown>
    const path = input.file_path ?? input.notebook_path
    if (EDIT_TOOLS.includes(e.tool) && typeof path === 'string' && ran.deny === undefined && ran.isError !== true) {
      const edit: FileEdit = { id: e.tool_use_id, path, tool: e.tool, diff: await buildDiff($, e.tool, path, input) }
      await update($, edits, list => [...list, edit].slice(-KEEP))
      await syncFooter($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }
    const blocks = parseBlocks(e.props.text)
    if (blocks.every(block => block.kind === 'markdown')) {
      return next(e)
    }
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const allRuns = await read($, runs)
    const allDrawings = await read($, drawings)
    const width = Math.max(20, (e.viewport?.columns ?? 80) - 6)

    const copyButtons = (i: number, drawn: string | null, source: string, what: string) => (
      <Box flexDirection="row" gap={2}>
        {drawn !== null && <Button key={`copy:${i}`} plain label="⧉ Copy" onPress={() => copy($, drawn, e.surface)} />}
        <Button key={`copy-src:${i}`} plain label={`⧉ Copy ${what}`} onPress={() => copy($, source, e.surface)} />
      </Box>
    )

    const draw = (block: Block, i: number) => {
      if (block.kind === 'markdown') {
        return <Markdown text={block.text} />
      }

      if (block.kind === 'shell') {
        const id = `${e.requestId}:${i}`
        const run = allRuns[id]

        return (
          <Box flexDirection="column" marginBottom={1}>
            <Markdown text={block.text} />
            <Box flexDirection="row" gap={2}>
              <Button key={`run:${i}`} plain label={run ? `${RUN_MARK[run.status]} Run again` : '▶ Run'} onPress={() => runCommand($, id, block.command)} />
              {!run && <Button key={`run-send:${i}`} plain label="▶ Run → Claude" onPress={() => runCommand($, id, block.command, true)} />}
              {run && run.status !== 'running' && (
                <Button key={`send:${i}`} plain label={run.sent ? '✓ Sent to Claude' : '↑ Send to Claude'} onPress={() => sendRun($, id, block.command)} />
              )}
              <Button key={`copy-src:${i}`} plain label="⧉ Copy" onPress={() => copy($, block.command, e.surface)} />
            </Box>
            {run &&
              (run.output || 'running…')
                .split('\n')
                .slice(0, OUTPUT_LINES)
                .map(line => (
                  <Text color={run.status === 'failed' ? 'error' : undefined} dimColor={run.status !== 'failed'}>
                    {clip(line, width)}
                  </Text>
                ))}
          </Box>
        )
      }

      if (block.kind === 'table') {
        const table = drawTable(block.rows, width)

        return (
          <Box flexDirection="column" marginY={1}>
            {table.lines.map((line, n) => (
              <Text bold={n >= 1 && n <= table.headerLines}>{line}</Text>
            ))}
            {copyButtons(i, table.lines.join('\n'), block.source, 'markdown')}
          </Box>
        )
      }

      const key = `${hash(block.source)}:${width}`
      const drawn = allDrawings[key]
      if (!drawn) {
        void drawMermaid($, key, block.source, width)
      }

      return (
        <Box flexDirection="column" marginY={1}>
          {drawn?.isDrawn ? (
            drawn.text.split('\n').map(line => <Text>{line}</Text>)
          ) : (
            <Box flexDirection="column">
              <Text dimColor>{drawn ? `mermaid-ascii could not draw this: ${drawn.text}` : 'Drawing diagram…'}</Text>
              <Markdown text={`\`\`\`mermaid\n${block.source}\n\`\`\``} />
            </Box>
          )}
          {copyButtons(i, drawn?.isDrawn ? drawn.text : null, block.source, 'mermaid')}
        </Box>
      )
    }

    return <Box flexDirection="column">{blocks.map(draw)}</Box>
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }
    const { Box, Button } = $.ui.resolve(e)
    const label = await filesLabel($)
    const below = await next(e)

    return (
      <Box flexDirection="row" gap={1}>
        {below}
        <Button key="open-files" plain label={label} onPress={() => togglePane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    const hint = e.props.hint.replace(SHORTCUT_HINT, '')

    return e.surface === 'terminal' && hint !== '' ? next({ ...e, props: { ...e.props, hint } }) : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Code, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, edits)
    const pulls = await read($, prs)
    const path = await read($, selected)
    const cwd = await $.session.cwd()
    const width = Math.max(20, (e.props?.bodyColumns ?? e.viewport?.columns ?? 60) - 4)
    const rows = Math.max(6, (e.viewport?.rows ?? 24) - 4)

    const forFile = path === null ? [] : list.filter(one => one.path === path)
    if (path !== null && forFile.length > 0) {
      return (
        <Box flexDirection="column">
          <Button key={BACK} plain hotkey="b" label="‹ Back" onPress={() => closeFile($, path)} />
          <Box marginY={1}>
            <Text bold>{clip(shortPath(path, cwd), width)}</Text>
          </Box>
          {forFile.map((one, i) => (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor>{`${one.tool} ${i + 1}/${forFile.length}`}</Text>
              <Code format="diff" path={path} source={diffSource(one)} />
            </Box>
          ))}
        </Box>
      )
    }

    if (list.length === 0 && pulls.length === 0) {
      return <Text dimColor>No files changed yet.</Text>
    }

    const files = [...new Set(list.map(one => one.path).reverse())]
    const fileRows = Math.max(1, rows - 1 - (pulls.length > 0 ? pulls.length + 3 : 0))

    return (
      <Box flexDirection="column">
        {pulls.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Pull requests</Text>
            {pulls.map(pr => (
              <Link href={graphiteUrl(pr)} label={clip(`${pr.owner}/${pr.repo}#${pr.number}`, width)} />
            ))}
          </Box>
        )}
        {pulls.length > 0 && <Text bold>Files</Text>}
        {list.length === 0 && <Text dimColor>No files changed yet.</Text>}
        {files.slice(0, fileRows).map(file => {
          const count = list.filter(one => one.path === file).length

          return (
            <Button
              key={`file:${file}`}
              plain
              label={clip(`${shortPath(file, cwd)}  ${count === 1 ? '1 change' : `${count} changes`}`, width - 2) + ' ›'}
              onPress={() => openFile($, file)}
            />
          )
        })}
      </Box>
    )
  })
}
