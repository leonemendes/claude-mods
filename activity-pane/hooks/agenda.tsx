import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Agenda, Meeting } from '../types'

const CALENDARS = ['claude.ai Google Calendar', 'claude_ai_Google_Calendar']
const TITLE_CHARS = 24
const SHOWN = 3
const CONNECT_RETRY_MS = 15_000
const CONNECT_RETRIES = 20
const CACHE_KEY = 'agenda'

const agenda = atom({ plugin: 'activity-pane', key: 'agenda' } as const, { meetings: [], error: null, fetchedAt: null })
const now = atom({ plugin: 'activity-pane', key: 'now' } as const, 0)

type RawTime = { dateTime?: string; date?: string }
type RawEvent = {
  id?: string
  summary?: string
  status?: string
  eventType?: string
  start?: RawTime
  end?: RawTime
  conferenceUrl?: string
  htmlLink?: string
  attendees?: { self?: boolean; responseStatus?: string }[]
}

function toMeeting(event: RawEvent): Meeting | null {
  const start = event.start?.dateTime
  const end = event.end?.dateTime
  const declined = event.attendees?.some(one => one.self && one.responseStatus === 'declined')
  if (!start || !end || event.status === 'cancelled' || declined || (event.eventType ?? 'DEFAULT') !== 'DEFAULT') {
    return null
  }

  return {
    id: event.id ?? start,
    title: event.summary?.trim() || '(no title)',
    start,
    end,
    url: event.conferenceUrl ?? event.htmlLink ?? null,
  }
}

async function callCalendar($: EngineInterface) {
  let failure: unknown = null
  for (const server of CALENDARS) {
    try {
      return await $.mcp.call(server, 'list_events', { orderBy: 'startTime', pageSize: 25 })
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

let isLive = false

async function loadCached($: EngineInterface): Promise<boolean> {
  if ((await read($, agenda)).fetchedAt !== null) {
    return false
  }
  const cached = (await $.store.get(CACHE_KEY).catch(() => null)) as Pick<Agenda, 'meetings' | 'fetchedAt'> | null
  if (!cached || !Array.isArray(cached.meetings) || typeof cached.fetchedAt !== 'number') {
    return false
  }
  await update($, agenda, () => ({ meetings: cached.meetings, error: null, fetchedAt: cached.fetchedAt }))

  return true
}

export async function refreshAgenda($: EngineInterface, onChange: () => Promise<void>, attempt = 0): Promise<void> {
  if (attempt === 0 && (await loadCached($))) {
    await onChange()
  }
  let next: Agenda
  try {
    const result = await callCalendar($)
    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    if (result.isError) {
      throw new Error(text || 'the calendar tool failed')
    }
    const events = (JSON.parse(text) as { events?: RawEvent[] }).events ?? []
    next = { meetings: events.map(toMeeting).filter((one): one is Meeting => one !== null), error: null, fetchedAt: Date.now() }
    isLive = true
    await $.store.set(CACHE_KEY, { meetings: next.meetings, fetchedAt: next.fetchedAt }).catch(() => undefined)
  } catch (error) {
    const previous = await read($, agenda)
    if (!isLive && attempt < CONNECT_RETRIES) {
      $.clock.after(CONNECT_RETRY_MS, () => refreshAgenda($, onChange, attempt + 1))
      return
    }
    next = { ...previous, error: error instanceof Error ? error.message : String(error) }
  }
  await update($, agenda, () => next)
  await update($, now, () => Date.now())
  await onChange()
}

export async function tickNow($: EngineInterface): Promise<void> {
  await update($, now, () => Date.now())
}

function offsetMs(iso: string): number {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso)

  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0
}

function isToday(iso: string, at: number): boolean {
  return iso.slice(0, 10) === new Date(at + offsetMs(iso)).toISOString().slice(0, 10)
}

function clock(iso: string): string {
  return iso.slice(11, 16)
}

function until(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60

  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
}

function short(text: string): string {
  return text.length > TITLE_CHARS ? text.slice(0, TITLE_CHARS - 1) + '…' : text
}

export type AgendaPart = { text: string; url: string | null }

function describe(meeting: Meeting, at: number, isFirst: boolean): AgendaPart {
  const start = Date.parse(meeting.start)
  if (start <= at) {
    return { text: `● ${short(meeting.title)} until ${clock(meeting.end)}`, url: meeting.url }
  }
  const text = isFirst ? `◷ ${clock(meeting.start)} ${short(meeting.title)} (in ${until(start - at)})` : `${clock(meeting.start)} ${short(meeting.title)}`

  return { text, url: meeting.url }
}

const plain = (text: string): AgendaPart => ({ text, url: null })

export async function agendaParts($: EngineInterface): Promise<AgendaPart[]> {
  const state = await read($, agenda)
  const at = (await read($, now)) || Date.now()
  if (state.fetchedAt === null) {
    return state.error ? [plain(`◷ calendar unavailable: ${state.error.replace(/\s+/g, ' ').slice(0, 80)}`)] : []
  }
  const stale = state.error ? [plain(`cached ${until(at - state.fetchedAt)} ago`)] : []
  const today = state.meetings.filter(one => Date.parse(one.end) > at && isToday(one.start, at))
  if (today.length === 0) {
    return [plain('◷ no more meetings today'), ...stale]
  }
  const shown = today.slice(0, SHOWN).map((one, i) => describe(one, at, i === 0))
  const more = today.length - SHOWN

  return [...shown, ...(more > 0 ? [plain(`+${more}`)] : []), ...stale]
}
