import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptSubmitCommand, PromptSubmitInput } from 'claude-code'

const STATE = '/jobs/abc/state.json'

function fakeEngine(on: On, labels: string[], names: string[] = []) {
  const files: Record<string, string> = {
    [STATE]: JSON.stringify({ name: 'pr app 101 context lookup', state: 'working' }),
  }
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_JOB_DIR' ? '/jobs/abc' : undefined }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('model.classify', () => ({ value: labels.shift() }))
  on('model.complete', () => {
    const text = names.shift()
    return {
      value: (text === undefined ? { isAnswered: false, reason: 'empty-reply' } : { isAnswered: true, text }) as never,
    }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)

  return {
    rename: (name: string, nameSource = 'auto') => {
      files[STATE] = JSON.stringify({ ...JSON.parse(files[STATE]!), name, nameSource })
    },
    advance: (ms: number) => clock.advance(ms),
    name: () => (JSON.parse(files[STATE]!) as { name: string }).name,
    state: () => (JSON.parse(files[STATE]!) as { state: string }).state,
    settle: () => clock.settle(),
  }
}

function submit($: Engine, text: string, command?: PromptSubmitCommand) {
  return $.prompt.submit({ text, command, wait: false, origin: { kind: 'composer' } } as PromptSubmitInput)
}

test('the first prompt tags the job name, once', async ($, on) => {
  const job = fakeEngine(on, ['review'])

  await submit($, 'we had opened a pr on app 101, bring the context back')
  await job.settle()
  expect(job.name()).toBe('review · pr app 101 context lookup')
  expect(job.state()).toBe('working')

  await submit($, 'now query posthog for signups')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await job.settle()
  expect(job.name()).toBe('review · pr app 101 context lookup')
})

test('/clear classifies and renames the next chat', async ($, on) => {
  const job = fakeEngine(on, ['code', 'meeting'], ['"Design Team 3pm Prep."'])

  await submit($, 'fix the flaky test')
  await job.settle()
  expect(job.name()).toBe('code · pr app 101 context lookup')

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await submit($, 'prep my 3pm with the design team')
  await job.settle()
  expect(job.name()).toBe('meeting · design team 3pm prep')

  await submit($, 'add the roadmap to the agenda')
  await job.advance(10_000)
  expect(job.name()).toBe('meeting · design team 3pm prep')
})

test('the first prompt keeps the name the daemon gave', async ($, on) => {
  const job = fakeEngine(on, ['code'], ['something else'])

  await submit($, 'fix the flaky test')
  await job.settle()
  expect(job.name()).toBe('code · pr app 101 context lookup')
})

test('/clear keeps a name the person typed', async ($, on) => {
  const job = fakeEngine(on, ['code'], ['something else'])
  job.rename('my release notes', 'user')

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await submit($, 'fix the flaky test')
  await job.settle()
  expect(job.name()).toBe('code · my release notes')
})

test('a failed rename after /clear tries again on the next prompt', async ($, on) => {
  const names: string[] = []
  const job = fakeEngine(on, ['data'], names)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await submit($, 'how many signups last week?')
  await job.settle()
  expect(job.name()).toBe('data · pr app 101 context lookup')

  names.push('weekly signups')
  await submit($, 'split them by country')
  await job.settle()
  expect(job.name()).toBe('data · weekly signups')
})

test('slash commands do not count as the first prompt', async ($, on) => {
  const job = fakeEngine(on, ['general'])

  await submit($, '/model', { name: 'model', args: '' } as PromptSubmitCommand)
  await job.settle()
  expect(job.name()).toBe('pr app 101 context lookup')
})

test('a name the daemon writes after the turn is tagged by the timer', async ($, on) => {
  const job = fakeEngine(on, ['data'])
  job.rename('')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await submit($, 'how many signups last week?')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await job.settle()
  expect(job.name()).toBe('')

  job.rename('weekly signups query')
  await job.advance(10_000)
  expect(job.name()).toBe('data · weekly signups query')
})
