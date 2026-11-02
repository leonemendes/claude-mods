# claude-mods

Mods for Claude Code in the terminal.

| Mod | What it does |
| --- | --- |
| `activity-pane` | A Files pane with the diffs and PRs of the session. In replies: `▶ Run` under each bash block, `▶ Run → Claude` to run it and send the output to the model, `↑ Send to Claude` after a plain run, Mermaid drawn as ASCII, tables redrawn to fit, and copy buttons. A footer file for the status line with today's meetings (Google Calendar connector). |
| `job-tags` | Puts a category (code, review, data, meeting, research, general) before each background job's name, from its first prompt, and names the job again after `/clear`. |

## Install

At the prompt of a terminal session:

```
/plugin install activity-pane --marketplace leonemendes/claude-mods
```

```
/plugin install job-tags --marketplace leonemendes/claude-mods
```

From a shell:

```bash
claude plugin install activity-pane --marketplace leonemendes/claude-mods
```

```bash
claude plugin install job-tags --marketplace leonemendes/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `leonemendes/claude-mods`, then Add plugin.

## Develop

```bash
claude plugin validate activity-pane
```

```bash
claude plugin test activity-pane
```
