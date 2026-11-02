#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

type Style = { c?: string; b?: boolean; d?: boolean; u?: boolean; bg?: string };
type Span = Style & { t: string };
type Line = Span[];
type Frame = { lines: Line[]; ms: number };
type Demo = { name: string; title: string; cols: number; rows: number; frames: Frame[] };

const C = {
  bg: "#1e1e2e",
  bar: "#181825",
  fg: "#cdd6f4",
  dim: "#7f849c",
  green: "#a6e3a1",
  red: "#f38ba8",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  accent: "#d97757",
  code: "#b4befe",
  press: "#45475a",
  border: "#585b70",
};

const CHAR_W = 8.4;
const LINE_H = 20;
const PAD_X = 16;
const PAD_TOP = 54;
const PAD_BOTTOM = 16;
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const s = (t: string, style: Style = {}): Span => ({ t, ...style });
const L = (...spans: (Span | string)[]): Line => spans.map(one => (typeof one === "string" ? s(one) : one));
const blank: Line = [];

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function drawLine(line: Line, row: number): string {
  const y = PAD_TOP + row * LINE_H;
  let col = 0;
  const parts: string[] = [];
  for (const span of line) {
    const x = PAD_X + col * CHAR_W;
    const width = [...span.t].length * CHAR_W;
    if (span.bg) {
      parts.push(`<rect x="${x - 2}" y="${y - 15}" width="${width + 4}" height="${LINE_H}" rx="3" fill="${span.bg}"/>`);
    }
    const fill = span.c ?? (span.d ? C.dim : C.fg);
    const attrs = [`x="${x}"`, `y="${y}"`, `fill="${fill}"`, `textLength="${width.toFixed(1)}"`, `lengthAdjust="spacingAndGlyphs"`];
    if (span.b) attrs.push(`font-weight="700"`);
    if (span.u) attrs.push(`text-decoration="underline"`);
    if (span.t.trim()) parts.push(`<text ${attrs.join(" ")}>${escape(span.t)}</text>`);
    col += [...span.t].length;
  }

  return parts.join("");
}

function drawFrame(frame: Frame): string {
  return frame.lines.map(drawLine).join("\n");
}

function chrome(demo: Demo, body: string, style = ""): string {
  const width = Math.ceil(PAD_X * 2 + demo.cols * CHAR_W);
  const height = PAD_TOP + (demo.rows - 1) * LINE_H + PAD_BOTTOM + 6;
  const dots = [C.red, C.yellow, C.green].map((fill, i) => `<circle cx="${20 + i * 18}" cy="15" r="5.5" fill="${fill}"/>`).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(demo.title)}">
<title>${escape(demo.title)}</title>
<style>text{font-family:${FONT};font-size:14px;white-space:pre}${style}</style>
<rect width="${width}" height="${height}" rx="10" fill="${C.bg}"/>
<rect width="${width}" height="30" rx="10" fill="${C.bar}"/><rect y="20" width="${width}" height="10" fill="${C.bar}"/>
${dots}<text x="${width / 2}" y="20" fill="${C.dim}" text-anchor="middle" style="font-size:12px">${escape(demo.title)}</text>
${body}
</svg>
`;
}

function animated(demo: Demo): string {
  demo.frames.forEach((frame, f) =>
    frame.lines.forEach((line, row) => {
      const width = line.reduce((n, span) => n + [...span.t].length, 0);
      if (width > demo.cols) throw new Error(`${demo.name} frame ${f} row ${row} is ${width} wide, over ${demo.cols}`);
      if (row >= demo.rows) throw new Error(`${demo.name} frame ${f} has more than ${demo.rows} rows`);
    }),
  );
  const total = demo.frames.reduce((sum, frame) => sum + frame.ms, 0);
  let start = 0;
  const styles: string[] = [];
  const groups: string[] = [];
  demo.frames.forEach((frame, i) => {
    const from = (start / total) * 100;
    const to = ((start + frame.ms) / total) * 100;
    start += frame.ms;
    const stops = [
      from > 0 ? `0%,${(from - 0.001).toFixed(3)}%{opacity:0}` : "",
      `${from.toFixed(3)}%,${(to - 0.001).toFixed(3)}%{opacity:1}`,
      to < 100 ? `${to.toFixed(3)}%,100%{opacity:0}` : "",
    ].filter(Boolean);
    styles.push(`@keyframes f${i}{${stops.join("")}}.f${i}{opacity:${i === demo.frames.length - 1 ? 1 : 0};animation:f${i} ${total}ms step-end infinite}`);
    groups.push(`<g class="f${i}">\n${drawFrame(frame)}\n</g>`);
  });

  return chrome(demo, groups.join("\n"), styles.join(""));
}

const SGR = /\x1b\[([0-9;]*)m/y;
const OSC8 = /\x1b\]8;;([^\x07]*)\x07/y;
const ANSI_COLORS: Record<string, string> = { "31": C.red, "32": C.green, "33": C.yellow };

function fromAnsi(text: string): Line {
  const line: Line = [];
  let style: Style = {};
  let link = false;
  let i = 0;
  let buffer = "";
  const flush = () => {
    if (buffer) line.push({ t: buffer, ...style, ...(link ? { u: true } : {}) });
    buffer = "";
  };
  while (i < text.length) {
    SGR.lastIndex = i;
    const sgr = SGR.exec(text);
    if (sgr) {
      flush();
      for (const code of (sgr[1] || "0").split(";")) {
        if (code === "0") style = {};
        else if (code === "1") style = { ...style, b: true };
        else if (code === "2") style = { ...style, d: true };
        else if (ANSI_COLORS[code]) style = { ...style, c: ANSI_COLORS[code] };
      }
      i = SGR.lastIndex;
      continue;
    }
    OSC8.lastIndex = i;
    const osc = OSC8.exec(text);
    if (osc) {
      flush();
      link = osc[1] !== "";
      i = OSC8.lastIndex;
      continue;
    }
    buffer += text[i];
    i++;
  }
  flush();

  return line;
}

function pad(line: Line, cols: number, right: Line): Line {
  const used = line.reduce((n, span) => n + [...span.t].length, 0);
  const rightWidth = right.reduce((n, span) => n + [...span.t].length, 0);

  return [...line, s(" ".repeat(Math.max(1, cols - used - rightWidth))), ...right];
}

async function statusLines(cols: number, filesButton: string): Promise<Line[]> {
  const home = mkdtempSync(join(tmpdir(), "statusline-demo-"));
  const sessionId = "demo-session";
  const now = Date.now();
  const hhmm = (offsetMin: number) => new Date(now + offsetMin * 60_000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const footer = {
    calendar: [
      { text: `◷ ${hhmm(25)} Design review (in 25m)`, url: "https://example.com/meet/a" },
      { text: `${hhmm(120)} Team sync`, url: "https://example.com/meet/b" },
      { text: `${hhmm(240)} 1:1`, url: null },
    ],
    buttonWidth: filesButton.length + 1,
    isCompact: false,
    at: now,
  };
  mkdirSync(join(home, ".claude", "cache", "activity-footer"), { recursive: true });
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(home, ".claude", "cache", "activity-footer", `${sessionId}.json`), JSON.stringify(footer));
  const sessions: [string, string][] = [["a", "busy"], ["b", "busy"], ["c", "idle"], ["d", "idle"], ["e", "idle"]];
  for (const [name, status] of sessions) {
    writeFileSync(join(home, ".claude", "sessions", `${name}.json`), JSON.stringify({ pid: process.pid, status }));
  }
  const input = {
    session_id: sessionId,
    model: { display_name: "Opus 5.5" },
    effort: { level: "high" },
    context_window: { used_percentage: 38 },
    rate_limits: { five_hour: { used_percentage: 54, resets_at: Math.floor(now / 1000) + 2 * 3600 }, seven_day: { used_percentage: 83, resets_at: Math.floor(now / 1000) + 3 * 86400 } },
    cost: { total_cost_usd: 4.27 },
  };
  const script = join(dirname(import.meta.dir), "statusline", "statusline.ts");
  const ran = Bun.spawnSync(["bun", script], { stdin: Buffer.from(JSON.stringify(input)), env: { ...process.env, HOME: home, COLUMNS: String(cols) } });
  if (ran.exitCode !== 0) throw new Error(`statusline.ts failed: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trimEnd().split("\n").map(fromAnsi);
}

function promptBox(cols: number, text = ""): Line[] {
  const inner = cols - 2;
  return [
    L(s("╭" + "─".repeat(inner) + "╮", { c: C.border })),
    L(s("│", { c: C.border }), s(" > ", { c: C.dim }), s(text.padEnd(inner - 3)), s("│", { c: C.border })),
    L(s("╰" + "─".repeat(inner) + "╯", { c: C.border })),
  ];
}

const user = (text: string): Line => L(s("> ", { c: C.dim }), s(text, { d: true }));
const claude = (text: string): Line => L(s("● ", { c: C.accent }), s(text));
const indent = (...spans: (Span | string)[]): Line => L(s("  "), ...spans);
const button = (label: string, pressed = false): Span => s(label, pressed ? { c: C.fg, bg: C.press, b: true } : { c: C.blue });
const gap = s("   ");

function runDemo(): Demo {
  const cols = 92;
  const head: Line[] = [
    user("why does the auth test fail on my machine?"),
    blank,
    claude("Run the suite and look at the first failure:"),
    blank,
    indent(s("make test", { c: C.code })),
    blank,
  ];
  const buttons = (pressed: boolean) => indent(button("▶ Run"), gap, button("▶ Run → Claude", pressed), gap, button("⧉ Copy"));
  const output = [
    indent(s("FAIL src/auth.test.ts > signs in with a saved key", { c: C.red })),
    indent(s("  expected 200, received 401", { c: C.red })),
    indent(s("Tests  1 failed | 23 passed", { c: C.red })),
  ];
  const after = indent(button("✗ Run again"), gap, s("✓ Sent to Claude", { c: C.green }), gap, button("⧉ Copy"));
  const sent: Line[] = [
    blank,
    L(s("> ", { c: C.dim }), s("activity-pane: ", { c: C.accent }), s("I ran this command from your reply (exit 2):", { d: true })),
    L(s("  make test · 3 lines of output", { d: true })),
    blank,
    claude("The key in .env.test expired, so sign-in returns 401. I will point the"),
    indent(s("test at the fixture key instead.")),
  ];
  const frame = (lines: Line[], ms: number): Frame => ({ lines: [...lines, ...Array(16 - lines.length).fill(blank), ...promptBox(cols)], ms });

  return {
    name: "activity-pane-run",
    title: "activity-pane · Run → Claude",
    cols,
    rows: 19,
    frames: [
      frame([...head, buttons(false)], 1800),
      frame([...head, buttons(true)], 700),
      frame([...head, indent(button("… Run again"), gap, button("⧉ Copy")), indent(s("running…", { d: true }))], 1000),
      frame([...head, after, ...output], 1200),
      frame([...head, after, ...output, ...sent], 4200),
    ],
  };
}

function filesDemo(): Demo {
  const cols = 92;
  const paneCol = 52;
  const chat: Line[] = [
    claude("Fixed the redirect and opened the PR:"),
    indent(s("https://app.graphite.com/github/pr/acme/app/42", { c: C.blue, u: true })),
    blank,
    claude("Edited 3 files."),
  ];
  const label = "Files 3 · PRs 1 ›";
  const mode = (pressed: boolean) => pad(L(s("⏵⏵ auto mode on", { c: C.accent })), cols, [pressed ? button(label, true) : s(label, { c: C.blue })]);
  const split = (left: Line[], right: Line[], rows: number): Line[] =>
    Array.from({ length: rows }, (_, i) => {
      const l = left[i] ?? blank;
      const used = l.reduce((n, span) => n + [...span.t].length, 0);
      return [...l, s(" ".repeat(Math.max(1, paneCol - used - 2))), s("│ ", { c: C.border }), ...(right[i] ?? blank)];
    });
  const list = (pressed: boolean): Line[] => [
    L(s("Files", { b: true }), s("  (/activity)", { d: true })),
    blank,
    L(s("Pull requests", { b: true })),
    L(s("acme/app#42", { c: C.blue, u: true })),
    blank,
    L(s("Files", { b: true })),
    L(pressed ? button("src/auth.ts  2 changes ›", true) : s("src/auth.ts  2 changes ›", { c: C.blue })),
    L(s("src/routes.ts  1 change ›", { c: C.blue })),
    L(s("README.md  1 change ›", { c: C.blue })),
  ];
  const diff: Line[] = [
    L(s("‹ Back", { c: C.blue })),
    blank,
    L(s("src/auth.ts", { b: true })),
    L(s("Edit 1/2", { d: true })),
    L(s("@@ -12,5 +12,5 @@", { c: C.blue })),
    L(s("   const next = params.get('next')", { d: true })),
    L(s("-  return redirect('/')", { c: C.red })),
    L(s("+  return redirect(safePath(next))", { c: C.green })),
    L(s("   }", { d: true })),
    blank,
    L(s("Edit 2/2", { d: true })),
    L(s("+import { safePath } from './paths'", { c: C.green })),
  ];
  const rows = 13;
  const frame = (body: Line[], pressed: boolean, ms: number): Frame => ({
    lines: [...body, ...Array(rows - body.length).fill(blank), ...promptBox(cols), mode(pressed)],
    ms,
  });

  return {
    name: "activity-pane-files",
    title: "activity-pane · Files pane",
    cols,
    rows: rows + 4,
    frames: [
      frame(chat, false, 1600),
      frame(chat, true, 600),
      frame(split(chat, list(false), rows), false, 1600),
      frame(split(chat, list(true), rows), false, 600),
      frame(split(chat, diff, rows), false, 3600),
    ],
  };
}

async function statuslineDemo(): Promise<Demo> {
  const cols = 100;
  const label = "Files 3 · PRs 1 ›";
  const lines = await statusLines(cols, label);
  const [first = blank, ...rest] = lines;
  const chat: Line[] = [claude("Done. The tests pass and the PR is up."), blank];

  return {
    name: "statusline",
    title: "statusline · the lower bar",
    cols,
    rows: chat.length + 3 + lines.length,
    frames: [{ lines: [...chat, ...promptBox(cols), pad(first, cols, [s(label, { c: C.blue })]), ...rest], ms: 1000 }],
  };
}

function jobsDemo(): Demo {
  const cols = 80;
  const header = [L(s("Background jobs", { b: true })), blank];
  const row = (state: string, name: Line, color: string): Line => [s(` ${state.padEnd(9)}`, { c: color }), ...name];
  const tag = (value: string) => s(`${value} · `, { c: C.accent, b: true });
  const plain = (text: string) => s(text);
  const pending = (text: string) => s(text, { d: true });
  const frame = (rows: Line[], note: string, ms: number): Frame => ({ lines: [...header, ...rows, blank, L(s(note, { d: true }))], ms });
  const done = row("done", [tag("review"), plain("pr app 101 context lookup")], C.green);
  const meeting = row("waiting", [tag("meeting"), plain("prep notes for team sync")], C.yellow);

  return {
    name: "job-tags",
    title: "job-tags · categories on background jobs",
    cols,
    rows: 8,
    frames: [
      frame([done, meeting, row("working", [pending("fix the login redirect after sso")], C.blue)], "a new job starts with its first prompt as its name", 1800),
      frame([done, meeting, row("working", [tag("code"), plain("fix the login redirect after sso")], C.blue)], "haiku picks a category from the first prompt", 2200),
      frame([done, meeting, row("working", [tag("code"), pending("/clear")], C.blue)], "/clear resets the tag and the name", 1400),
      frame([done, meeting, row("working", [tag("data"), plain("weekly signups by country")], C.blue)], "the next prompt sets a new category and a new name", 3000),
    ],
  };
}

const out = import.meta.dir;
const preview = process.argv.includes("--frames") ? process.argv[process.argv.indexOf("--frames") + 1] : undefined;
for (const demo of [runDemo(), filesDemo(), await statuslineDemo(), jobsDemo()]) {
  writeFileSync(join(out, `${demo.name}.svg`), animated(demo));
  if (preview) {
    mkdirSync(preview, { recursive: true });
    demo.frames.forEach((frame, i) => writeFileSync(join(preview, `${demo.name}-${i}.svg`), chrome(demo, drawFrame(frame))));
  }
  console.log(`${demo.name}.svg  ${demo.frames.length} frame(s)`);
}
