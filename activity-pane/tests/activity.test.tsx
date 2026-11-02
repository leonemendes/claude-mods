import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'activity-pane',
  component: 'Pane',
  requestId: 'activity',
  surface: 'terminal',
  props: { title: 'Files', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

function base(on: any, opened: unknown[] = []) {
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('ui.open', (_: unknown, e: unknown) => (opened.push(e), { value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.render', { component: 'SessionMode' }, ($: any, e: any) => {
    if (e.surface !== 'terminal') throw new Error('no implementation for ui.render')
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.modes.join(' & ')}</Text>
  })
}

test('empty pane says so', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /No files changed/ }))?.text).toBe('No files changed yet.')
  await ui.unmount()
})

test('only successful file edits are listed, and a click swaps the list for the diff', async ($, on) => {
  base(on)
  let n = 0
  on('tool.call', () => (++n === 3 ? { deny: 'no' } : { result: {}, text: 'ok' }))
  const file = ['l1', 'l2', 'l3', 'l4', 'l5', 'const x = new line here', 'l7', 'l8', 'l9', 'l10'].join('\n') + '\n'
  on('fs.read', () => ({ value: file }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'old line', new_string: 'new line' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/denied.ts', content: 'x' } as never)

  const ui = await $.ui.mount(PANE)
  const row = await ui.find({ type: 'Button', text: /a\.ts/ })
  expect(row?.text).toContain('1 change')
  expect(await ui.find({ type: 'Button', text: /denied|ls/ })).toBeUndefined()

  await ui.press({ key: row!.key! })
  expect(await ui.find({ type: 'Button', text: /a\.ts/ })).toBeUndefined()
  const code = (await ui.find({ type: 'Code' })) as any
  expect(code?.props?.format ?? code?.format).toBe('diff')
  expect(code?.props?.source ?? code?.source).toBe(
    ['@@ -3,7 +3,7 @@', ' l3', ' l4', ' l5', '-const x = old line here', '+const x = new line here', ' l7', ' l8', ' l9'].join('\n'),
  )

  const back = await ui.find({ type: 'Button', text: /Back/ })
  await ui.press({ key: back!.key! })
  expect(await ui.find({ type: 'Button', text: /a\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('a shell block in a reply gets an inline Run button that shows its output', async ($, on) => {
  base(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'hi', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({
    plugin: 'activity-pane',
    component: 'AssistantMessage',
    requestId: 'm1',
    surface: 'terminal',
    props: { text: 'Try:\n```bash\necho hi\n```\n```python\nprint(1)\n```', isFirstOfReply: true },
  } as never)
  const buttons = await msg.findAll({ type: 'Button' })
  expect(buttons.map(b => b.text)).toEqual(['▶ Run', '▶ Run → Claude', '⧉ Copy'])
  await msg.press({ key: buttons[0]!.key! })
  expect((await msg.find({ type: 'Text', text: /^hi$/ }))?.text).toBe('hi')
  expect((await msg.find({ type: 'Button', text: /Run again/ }))?.text).toContain('✓')
  await msg.unmount()
})

function shellReply(requestId: string, command: string) {
  return {
    plugin: 'activity-pane',
    component: 'AssistantMessage',
    requestId,
    surface: 'terminal',
    props: { text: '```bash\n' + command + '\n```', isFirstOfReply: true },
  } as never
}

test('Run → Claude runs the block and sends its output to the model once', async ($, on) => {
  base(on)
  const sent: string[] = []
  on('process.run', () => ({ value: { exitCode: 2, stdout: 'out', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', (_: unknown, e: { text: string }) => (sent.push(e.text), { text: e.text }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount(shellReply('m2', 'make test'))
  await msg.press({ key: (await msg.find({ type: 'Button', text: /Run → Claude/ }))!.key! })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('make test')
  expect(sent[0]).toContain('exit 2')
  expect(sent[0]).toContain('out\nboom')
  const done = await msg.find({ type: 'Button', text: /Sent to Claude/ })
  expect(done?.text).toBe('✓ Sent to Claude')
  await msg.press({ key: done!.key! })
  expect(sent).toHaveLength(1)
  await msg.unmount()
})

test('a plain Run sends nothing until Send to Claude is pressed', async ($, on) => {
  base(on)
  const sent: string[] = []
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'hi', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', (_: unknown, e: { text: string }) => (sent.push(e.text), { text: e.text }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount(shellReply('m3', 'echo hi'))
  await msg.press({ key: (await msg.find({ type: 'Button', text: /^▶ Run$/ }))!.key! })
  expect(sent).toHaveLength(0)
  await msg.press({ key: (await msg.find({ type: 'Button', text: /Send to Claude/ }))!.key! })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('exit 0')
  await msg.unmount()
})

test('only PRs created in the session are listed, as Graphite links', async ($, on) => {
  base(on)
  const outputs: Record<string, string> = {
    'gh pr create --fill': 'https://github.com/acme/app/pull/42\n',
    'gh pr view 9': 'https://github.com/acme/app/pull/9',
    'gt submit --stack': 'feat-a: https://app.graphite.com/github/pr/acme/app/40 (updated)\nfeat-b: https://app.graphite.com/github/pr/acme/app/43 (created)',
    'cd repo && gt ss': 'feat-b: https://app.graphite.com/github/pr/acme/app/43 (created)',
  }
  on('tool.call', (_: unknown, e: any) => ({ result: {}, text: outputs[e.command] ?? '' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (const command of Object.keys(outputs)) {
    await $.tool.call({ tool: 'Bash', command })
  }

  const ui = await $.ui.mount(PANE)
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(link => (link as any).props?.href ?? (link as any).href)).toEqual([
    'https://app.graphite.com/github/pr/acme/app/42',
    'https://app.graphite.com/github/pr/acme/app/43',
  ])
  await ui.unmount()

})

const MESSAGE = (text: string) =>
  ({ plugin: 'activity-pane', component: 'AssistantMessage', requestId: 'm2', surface: 'terminal', props: { text, isFirstOfReply: true } }) as never

test('a mermaid block is drawn as ASCII, with copy buttons for the drawing and the source', async ($, on) => {
  base(on)
  const stdins: string[] = []
  const copied: string[] = []
  on('process.run', (_: unknown, e: any) => ((e.init?.stdin ?? e.stdin) !== undefined && stdins.push(e.init?.stdin ?? e.stdin), { value: { exitCode: 0, stdout: '┌───┐\n│ A │\n└───┘\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.copy', (_: unknown, e: any) => (copied.push(e.text), { value: { isCopied: true } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount(MESSAGE('Here:\n```mermaid\ngraph LR\nA --> B\n```\ndone'))
  await new Promise(resolve => (globalThis as any).setTimeout(resolve, 20))
  expect(stdins).toEqual(['graph LR\nA --> B'])
  expect((await msg.find({ type: 'Text', text: /│ A │/ }))?.text).toBe('│ A │')

  await msg.press({ key: (await msg.find({ type: 'Button', text: /^⧉ Copy$/ }))!.key! })
  await msg.press({ key: (await msg.find({ type: 'Button', text: /Copy mermaid/ }))!.key! })
  expect(copied).toEqual(['┌───┐\n│ A │\n└───┘', 'graph LR\nA --> B'])
  await msg.unmount()
})

test('a markdown table is redrawn with box lines that fit the width, and copies', async ($, on) => {
  base(on)
  const copied: string[] = []
  on('ui.copy', (_: unknown, e: any) => (copied.push(e.text), { value: { isCopied: true } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const table = '| Name | Notes |\n|---|---|\n| **a** | short |\n| b | a much longer note that has to wrap inside its column because the whole table is wider than the room it gets |'
  const msg = await $.ui.mount(MESSAGE(`Intro\n\n${table}\n\nAfter`))
  const lines = (await msg.findAll({ type: 'Text' })).map(t => t.text!).filter(t => /^[┌│├└]/.test(t))
  expect(lines[0]!.startsWith('┌')).toBe(true)
  expect(lines.at(-1)!.startsWith('└')).toBe(true)
  expect(lines.some(l => l.includes('│ a ') && !l.includes('**'))).toBe(true)
  expect(Math.max(...lines.map(l => l.length))).toBeLessThanOrEqual(74)
  expect(lines.length).toBeGreaterThan(6)

  await msg.press({ key: (await msg.find({ type: 'Button', text: /Copy markdown/ }))!.key! })
  expect(copied).toEqual([table])
  await msg.unmount()
})

const iso = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000).toISOString().replace('.000Z', '+00:00')
const wait = (ms: number) => new Promise(resolve => (globalThis as any).setTimeout(resolve, ms))
const calendarText = (data: any) => (data?.calendar ?? []).map((part: any) => part.text).join(' · ')

function footerWrites(on: any) {
  const writes: { path: string; data: any }[] = []
  on('session.id', () => ({ value: 's1' }))
  on('fs.write', (_: unknown, e: any) => (writes.push({ path: e.path, data: JSON.parse(e.text) }), { value: undefined }))

  return writes
}

test('the footer file gets the meetings left today, on one line', async ($, on) => {
  base(on)
  const writes = footerWrites(on)
  const at = Date.now()
  const events = [
    { id: 'past', summary: 'Already over', start: { dateTime: iso(at - 3 * 3_600_000) }, end: { dateTime: iso(at - 2 * 3_600_000) } },
    { id: 'skip', summary: 'I declined', start: { dateTime: iso(at + 600_000) }, end: { dateTime: iso(at + 1_200_000) }, attendees: [{ self: true, responseStatus: 'declined' }] },
    { id: 'next', summary: 'Design review', start: { dateTime: iso(at + 1_800_000) }, end: { dateTime: iso(at + 2_400_000) } },
    { id: 'later', summary: 'Sync', start: { dateTime: iso(at + 2_700_000) }, end: { dateTime: iso(at + 3_000_000) } },
    { id: 'allday', summary: 'Holiday', start: { date: '2030-01-01' }, end: { date: '2030-01-02' } },
  ]
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ events }) }], isError: false } }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await wait(20)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } as never)

  const last = writes.at(-1)!
  expect(last.path.endsWith('/cache/activity-footer/s1.json')).toBe(true)
  expect(calendarText(last.data)).toMatch(/^◷ \d\d:\d\d Design review \(in (29|30)m\) · \d\d:\d\d Sync$/)
  expect(calendarText(last.data)).not.toMatch(/declined|Already over|Holiday/)
})

test('a calendar error lands in the footer file with its reason, not as a throw', async ($, on) => {
  base(on)
  const writes = footerWrites(on)
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'not connected' }], isError: true } }))
  on('clock.after', () => ({ value: undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await wait(20)
  expect(calendarText(writes.at(-1)?.data)).toBe('◷ calendar unavailable: not connected')
})

test('a calendar that is not connected yet is retried, and the footer gets the meetings once it answers', async ($, on) => {
  base(on)
  const writes = footerWrites(on)
  const at = Date.now()
  const events = [{ id: 'next', summary: 'Design review', start: { dateTime: iso(at + 1_800_000) }, end: { dateTime: iso(at + 2_400_000) } }]
  let calls = 0
  on('mcp.call', () => {
    calls++
    if (calls <= 4) {
      throw new Error('no connected MCP tool "list_events" on a server named claude.ai Google Calendar')
    }

    return { value: { content: [{ type: 'text', text: JSON.stringify({ events }) }], isError: false } }
  })
  on('clock.after', () => ({ value: undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await wait(20)
  expect(calls).toBe(5)
  expect(writes.some(w => /unavailable/.test(calendarText(w.data)))).toBe(false)
  expect(calendarText(writes.at(-1)?.data)).toMatch(/Design review/)
})

test('with the calendar down, the cached meetings show with a countdown, marked cached', async ($, on) => {
  base(on)
  const writes = footerWrites(on)
  const at = Date.now()
  const meetings = [{ id: 'next', title: 'Design review', start: iso(at + 3_600_000), end: iso(at + 4_200_000), url: null }]
  const store = new Map<string, unknown>([['agenda', { meetings, fetchedAt: at - 20 * 60_000 }]])
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) ?? null }))
  on('store.set', (_: unknown, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'not connected' }], isError: true } }))
  on('clock.after', () => ({ value: undefined }))
  const ticks: (() => unknown)[] = []
  on('clock.every', (_: unknown, e: any) => (ticks.push(e.fn), { value: undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await wait(30)

  const first = calendarText(writes.at(-1)!.data)
  expect(first).toMatch(/^◷ \d\d:\d\d Design review \(in (59m|1h)\) · cached 20m ago$/)
})

test('a live fetch is saved to the store for the next session', async ($, on) => {
  base(on)
  footerWrites(on)
  const at = Date.now()
  const events = [{ id: 'next', summary: 'Design review', start: { dateTime: iso(at + 1_800_000) }, end: { dateTime: iso(at + 2_400_000) } }]
  const saved: any[] = []
  on('store.get', () => ({ value: null }))
  on('store.set', (_: unknown, e: any) => (saved.push(e), { value: undefined }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ events }) }], isError: false } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await wait(20)
  expect(saved.at(-1)?.key).toBe('agenda')
  expect(saved.at(-1)?.value.meetings.map((m: any) => m.title)).toEqual(['Design review'])
})

test('each meeting in the footer carries its join link', async ($, on) => {
  base(on)
  const writes = footerWrites(on)
  const at = Date.now()
  const events = [
    { id: 'a', summary: 'Design review', start: { dateTime: iso(at + 1_800_000) }, end: { dateTime: iso(at + 2_400_000) }, conferenceUrl: 'https://meet.google.com/abc' },
    { id: 'b', summary: 'Sync', start: { dateTime: iso(at + 2_700_000) }, end: { dateTime: iso(at + 3_000_000) }, htmlLink: 'https://calendar.google.com/event?eid=b' },
  ]
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ events }) }], isError: false } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await wait(20)
  expect(writes.at(-1)?.data.calendar.map((part: any) => part.url)).toEqual(['https://meet.google.com/abc', 'https://calendar.google.com/event?eid=b'])
})

test('the Files button at the end of the mode line counts files and PRs, and toggles the pane', async ($, on) => {
  const opened: unknown[] = []
  base(on, opened)
  const closed: unknown[] = []
  let shown = false
  on('ui.panes', () => ({ value: shown ? [{ id: 'activity', title: 'Files', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.close', (_: unknown, e: unknown) => (closed.push(e), { value: undefined }))
  on('tool.call', (_: unknown, e: any) => ({ result: {}, text: e.tool === 'Bash' ? 'https://github.com/acme/app/pull/7' : 'ok' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  const footer = await $.ui.mount({ plugin: 'activity-pane', component: 'SessionMode', surface: 'terminal', props: { modes: ['focus'] } } as never)
  expect((await footer.find({ type: 'Text', text: /focus/ }))?.text).toBe('focus')
  const button = (await footer.find({ type: 'Button' }))!
  expect(button.text).toBe('Files 1 · PRs 1 ›')
  const before = opened.length
  await footer.press({ key: button.key! })
  expect(opened.length).toBe(before + 1)
  shown = true
  await footer.press({ key: button.key! })
  expect(closed.length).toBe(1)
  await footer.unmount()

  await expect($.ui.mount({ plugin: 'activity-pane', component: 'SessionMode', surface: 'desktop', props: { modes: [] } } as never)).rejects.toThrow(/no implementation for ui.render/)
})

test('a file with many changes shows every change in its diff view', async ($, on) => {
  base(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('fs.read', () => ({ value: 'a\nb\nc\n' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 5; i++) {
    await $.tool.call({ tool: 'Edit', file_path: '/repo/many.ts', old_string: `old ${i}`, new_string: `new ${i}` } as never)
  }
  const ui = await $.ui.mount(PANE)
  const row = await ui.find({ type: 'Button', text: /many\.ts/ })
  expect(row?.text).toContain('5 changes')
  await ui.press({ key: row!.key! })
  expect((await ui.findAll({ type: 'Code' })).length).toBe(5)
  expect((await ui.find({ type: 'Text', text: /Edit 5\/5/ }))?.text).toBe('Edit 5/5')
  await ui.unmount()
})

test('opening Files tells the status line to shrink, and closing it tells it to grow back', async ($, on) => {
  const opened: unknown[] = []
  base(on, opened)
  const writes = footerWrites(on)
  let closes = 0
  on('ui.panes', () => ({ value: opened.length > closes ? [{ id: 'activity', title: 'Files', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  on('ui.close', () => (closes++, { value: undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'activity-pane', component: 'SessionMode', surface: 'terminal', props: { modes: [] } } as never)
  const button = (await footer.find({ type: 'Button' }))!

  await footer.press({ key: button.key! })
  expect(writes.at(-1)?.data.isCompact).toBe(true)

  await footer.press({ key: button.key! })
  expect(writes.at(-1)?.data.isCompact).toBe(false)
  expect(writes.at(-1)?.data.buttonWidth).toBe('Files ›'.length)
  await footer.unmount()
})
