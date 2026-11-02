#!/usr/bin/env bun

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STATUS_LABEL: Record<string, string> = { busy: "running", idle: "waiting" };

export function sessionCounts(): Map<string, number> {
  const dir = join(homedir(), ".claude", "sessions");
  const counts = new Map<string, number>([["running", 0], ["waiting", 0]]);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return counts;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const { pid, status } = JSON.parse(readFileSync(join(dir, name), "utf8"));
      process.kill(pid, 0);
      const label = STATUS_LABEL[status] ?? status ?? "unknown";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    } catch {}
  }
  return counts;
}

if (import.meta.main) {
  console.log([...sessionCounts()].map(([label, n]) => `${n} ${label}`).join(" · "));
}
