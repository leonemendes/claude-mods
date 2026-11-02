#!/usr/bin/env bun

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import { sessionCounts } from "./session-counts.ts";

type Window = { used_percentage?: number; resets_at?: number };
type CalendarPart = { text: string; url: string | null };
type Footer = { calendar?: CalendarPart[]; buttonWidth?: number; isCompact?: boolean; at?: number };
type Input = {
  session_id?: string;
  model?: { display_name?: string };
  effort?: { level?: string };
  cost?: { total_cost_usd?: number };
  context_window?: { used_percentage?: number | null };
  rate_limits?: { five_hour?: Window; seven_day?: Window };
};

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const SEP = `${DIM} · ${RESET}`;
const SESSION_ICON: Record<string, string> = { running: "▶", waiting: "⏸", shell: "$" };

function color(pct: number): string {
  if (pct >= 80) return "\x1b[31m";
  if (pct >= 50) return "\x1b[33m";
  return "\x1b[32m";
}

function resetLabel(epochSeconds: number | undefined, withDay: boolean): string {
  if (!epochSeconds) return "";
  const d = new Date(epochSeconds * 1000);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = d.toLocaleDateString("en-GB", { weekday: "short" });
  return `${DIM} ↻${withDay ? `${day} ` : ""}${time}${RESET}`;
}

function usage(label: string, w: Window | undefined, withDay: boolean, withReset: boolean): string {
  if (w?.used_percentage == null) return `${label} ${DIM}–${RESET}`;
  const pct = Math.round(w.used_percentage);
  return `${label} ${color(pct)}${pct}%${RESET}${withReset ? resetLabel(w.resets_at, withDay) : ""}`;
}

const FOOTER_MAX_AGE_MS = 15 * 60_000;

function readFooter(dir: string, sessionId: string | undefined): Footer {
  if (!sessionId) return {};
  try {
    const footer: Footer = JSON.parse(readFileSync(join(homedir(), ".claude", "cache", dir, `${sessionId}.json`), "utf8"));
    return Date.now() - (footer.at ?? 0) < FOOTER_MAX_AGE_MS ? footer : {};
  } catch {
    return {};
  }
}

function footers(sessionId: string | undefined): Footer[] {
  try {
    return readdirSync(join(homedir(), ".claude", "cache"))
      .filter(dir => dir.endsWith("-footer"))
      .map(dir => readFooter(dir, sessionId));
  } catch {
    return [];
  }
}

const input: Input = JSON.parse((await Bun.stdin.text()) || "{}");
const footer = readFooter("activity-footer", input.session_id);
const buttons = footers(input.session_id);
const model = [
  `\x1b[1m${input.model?.display_name ?? "?"}\x1b[0m`,
  input.effort?.level ?? `${DIM}no effort${RESET}`,
  ...sessionIcons(),
];

function sessionIcons(): string[] {
  return [...sessionCounts()]
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${SESSION_ICON[label] ?? label} ${n}`);
}

function usageLine(withResets: boolean): string {
  const parts: string[] = [];
  const ctx = input.context_window?.used_percentage;
  if (ctx != null) parts.push(`ctx ${color(ctx)}${Math.round(ctx)}%${RESET}`);
  parts.push(usage("session", input.rate_limits?.five_hour, false, withResets));
  parts.push(usage("week", input.rate_limits?.seven_day, true, withResets));
  if (input.cost?.total_cost_usd != null) parts.push(`$${input.cost.total_cost_usd.toFixed(2)}`);
  return parts.join(SEP);
}

const link = ({ text, url }: CalendarPart) => (url ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : text);

function width(line: string): number {
  return [...line.replace(ESCAPES, "")].length;
}

function calendarLine(parts: CalendarPart[], max: number): string {
  for (let shown = parts.length; shown > 1; shown--) {
    const more = parts.length - shown;
    const line = [...parts.slice(0, shown).map(link), ...(more > 0 ? [`${DIM}+${more}${RESET}`] : [])].join(SEP);
    if (width(line) <= max) return line;
  }
  const more = parts.length - 1;
  const tail = more > 0 ? `${SEP}${DIM}+${more}${RESET}` : "";
  return fit(link(parts[0]!), max - width(tail)) + tail;
}

const ESCAPE = /^(\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07)/;
const ESCAPES = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;
const LINK_OPEN = /^\x1b\]8;;[^\x07]+\x07$/;

function fit(line: string, max: number): string {
  let out = "";
  let shown = 0;
  let inLink = false;
  let rest = line;
  while (rest.length > 0) {
    const escape = ESCAPE.exec(rest)?.[0];
    if (escape) {
      out += escape;
      inLink = escape.startsWith("\x1b]8") ? LINK_OPEN.test(escape) : inLink;
      rest = rest.slice(escape.length);
      continue;
    }
    const char = String.fromCodePoint(rest.codePointAt(0)!);
    rest = rest.slice(char.length);
    if (shown === max - 1 && rest.replace(ESCAPES, "").length > 0) {
      return out + "…" + (inLink ? "\x1b]8;;\x07" : "") + RESET;
    }
    out += char;
    shown++;
  }
  return out;
}

const RIGHT_GAP = 2;
const right = buttons.reduce((sum, one) => sum + (one.buttonWidth ?? 0), 0);
const columns = Number(process.env.COLUMNS);
const room = Number.isFinite(columns) && columns > 0 ? columns - 4 - right - RIGHT_GAP : Infinity;

const full = usageLine(true);
const lines = [model.join(SEP), width(full) <= room ? full : usageLine(false)];
if (Array.isArray(footer.calendar) && footer.calendar.length > 0) lines.push(calendarLine(footer.calendar, room));
const shown = buttons.some(one => one.isCompact) ? lines.slice(0, 1) : lines;

console.log((room > 10 && room !== Infinity ? shown.map(line => fit(line, room)) : shown).join("\n"));
