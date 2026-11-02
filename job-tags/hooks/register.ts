import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Tag } from '../types'

const TAGS: readonly Tag[] = ['code', 'review', 'data', 'meeting', 'research', 'general']
const SEP = ' · '
const TAGGED = new RegExp(`^(?:${TAGS.join('|')})${SEP}`)
const PROMPT_CHARS = 2000
const RETAG_MS = 10_000
const NAME_CHARS = 48
const NAMING =
  'Name the chat that opens with the message below in 3 to 6 lowercase words, like a short topic label. No quotes, no punctuation, no category prefix. Answer with the name alone.'

const tag = atom({ plugin: 'job-tags', key: 'tag' } as const, null)
const pending = atom({ plugin: 'job-tags', key: 'pending' } as const, true)
const title = atom({ plugin: 'job-tags', key: 'title' } as const, null)
const renaming = atom({ plugin: 'job-tags', key: 'renaming' } as const, false)

type Job = { name?: unknown; nameSource?: unknown; sessionId?: unknown }

const found = new Map<string, string>()

let queue: Promise<unknown> = Promise.resolve()

function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

function tagged(name: string, value: Tag): string {
  return `${value}${SEP}${name.replace(TAGGED, '')}`
}

async function statePath($: EngineInterface): Promise<string | undefined> {
  const dir = await $.env.get('CLAUDE_JOB_DIR')
  if (dir) {
    return `${dir}/state.json`
  }
  const home = await $.env.get('HOME')
  if (!home) {
    return undefined
  }
  const jobs = `${home}/.claude/jobs`
  if (!(await $.fs.exists(jobs))) {
    return undefined
  }
  const id = await $.session.id()
  const known = found.get(id)
  if (known) {
    return known
  }
  for (const entry of await $.fs.list(jobs)) {
    if (entry.kind !== 'dir') {
      continue
    }
    const path = `${jobs}/${entry.name}/state.json`
    const job = await readJob($, path)
    if (job?.sessionId === id) {
      found.set(id, path)
      return path
    }
  }

  return undefined
}

async function readJob($: EngineInterface, path: string): Promise<Job | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as Job
  } catch {
    return undefined
  }
}

function retag($: EngineInterface): Promise<void> {
  return serial(async () => {
    const value = await read($, tag)
    const fresh = await read($, title)
    if (value === null && fresh === null) {
      return
    }
    const path = await statePath($)
    if (!path) {
      return
    }
    const job = await readJob($, path)
    if (typeof job?.name !== 'string' || (fresh === null && job.name === '')) {
      return
    }
    const base = fresh ?? job.name
    const name = value === null ? base.replace(TAGGED, '') : tagged(base, value)
    if (name !== job.name) {
      await $.fs.write(path, JSON.stringify({ ...job, name }, null, 2))
    }
    if (fresh !== null) {
      await update($, title, () => null)
    }
  })
}

function cleanName(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line
    .toLowerCase()
    .replace(TAGGED, '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_CHARS)
    .trim()
}

async function retitle($: EngineInterface, text: string): Promise<void> {
  const path = await statePath($)
  const job = path ? await readJob($, path) : undefined
  if (job?.nameSource === 'user') {
    return
  }
  const reply = await $.model.complete({
    model: 'haiku',
    system: NAMING,
    prompt: text.slice(0, PROMPT_CHARS),
    maxTokens: 32,
    effort: 'low',
    timeoutMs: 15_000,
  })
  const name = reply.isAnswered ? cleanName(reply.text) : ''
  if (name === '') {
    await update($, renaming, () => true)
    return
  }
  await update($, title, () => name)
  await retag($)
}

async function classify($: EngineInterface, text: string): Promise<void> {
  const picked = await $.model.classify(text.slice(0, PROMPT_CHARS), TAGS, { model: 'haiku' })
  const value = TAGS.find(one => one === picked)
  if (value === undefined) {
    await update($, pending, () => true)
    return
  }
  await update($, tag, () => value)
  await retag($)
}

async function reset($: EngineInterface): Promise<void> {
  await update($, tag, () => null)
  await update($, pending, () => true)
  await update($, title, () => null)
  await update($, renaming, () => true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(RETAG_MS, () => void retag($).catch(() => undefined))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await reset($)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta === undefined && e.text.trim() !== '') {
      if (await read($, pending)) {
        await update($, pending, () => false)
        void classify($, e.text).catch(() => update($, pending, () => true))
      }
      if (await read($, renaming)) {
        await update($, renaming, () => false)
        void retitle($, e.text).catch(() => update($, renaming, () => true))
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void retag($).catch(() => undefined)

    return done
  })
}
