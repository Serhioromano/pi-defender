# Pi Defender — Agent Context

## Overview

Pi Defender is a Pi coding agent extension that provides defense-in-depth protection — intercepts tool calls (Bash, Write, Edit, Read) and blocks or prompts the user before dangerous operations.

**Entry point:** `src/index.ts` — exports a default function `(pi: ExtensionAPI) => void`.

## Architecture

```
src/
├── index.ts      # Extension entry: event handlers, commands, strict mode logic
├── config.ts     # Pattern matching, path checking, YAML config loading + merging
└── patterns.yaml # Bundled default patterns (shipped with the package)
```

### Loading chain

Only `.pi/` directories are read at runtime — never `src/` or `dist/`.

```
.pi/patterns.yaml ──────┐ essential rules (shipped, overwritten on install)
~/.pi/patterns.yaml ────┤
.pi/defender.yaml ──────┤ user rules + whitelist (NEVER overwritten)
~/.pi/defender.yaml ────┘
                         │
                         └──→ config.ts:loadConfig(cwd) ──→ getConfig()
                              (all 4 merged together)
```

On first session start, `ensurePatternsConfig(cwd)` copies the bundled
`src/patterns.yaml` defaults to `~/.pi/patterns.yaml` and `.pi/patterns.yaml`
if they don't already exist (idempotent). The `postinstall` script also
copies to `~/.pi/patterns.yaml` — always overwrites on install/update.

User whitelist entries are saved to `.pi/defender.yaml` (project-local) via
`addPatternsToWhitelist()`. This file is NEVER overwritten on install.

### Event flow

```
pi.on("message_start") → clears session-approved patterns + aborted flag
pi.on("message_end") → clears aborted flag

pi.on("tool_call") 3 handlers registered:
  1. Bash handler     → checkCommand() → pattern check → strict mode → normal
                         Deny/Abort calls ctx.abort() to cancel agent's turn
  2. Write/Edit handler → checkFileAccess() → path-based block
                         Also checks aborted flag — blocks when aborted
  3. Read handler       → checkFileAccess() → path-based block (zeroAccess only)
                         Reads allowed during abort for diagnostics

pi.on("session_start") → runs `ensurePatternsConfig` (idempotent deploy)
    → shows protection-level selector:
    🔒 Strict Mode ON (default) | 🛡️ Patterns only | ⚪ Disable Defender
    After selection, displays a config table breaking down which rules
    come from which source (.pi/patterns.yaml, ~/.pi/patterns.yaml,
    .pi/defender.yaml, ~/.pi/defender.yaml). Uses Unicode box-drawing
    characters: ┌─...─┐ ├─...─┤ └─...─┘ with columns: Pat, Zero, ROnly, NDel, Wlst.
    Also captures TUI theme early — fixes missing colors in whitelist-only
    notifications where no prompt ever fires.
pi.on("session_shutdown") → clears cached config, aborted flag, session-approved patterns
```

## Key concepts

### Patterns (src/patterns.yaml)

- **bashToolPatterns**: regex patterns with `reason` and optional `ask: true`
- **zeroAccessPaths**: no read/write/delete (secrets, keys)
- **readOnlyPaths**: read OK, write/edit blocked (system files, lockfiles)
- **noDeletePaths**: read/write/edit OK, delete blocked (project docs)
- **strictModeWhiteList**: regex patterns — commands matching these skip strict mode prompts

### Pattern matching (config.ts:checkCommand)

1. Tests `bashToolPatterns` regex against the bash command string
2. Checks if command references `zeroAccessPaths` (any operation)
3. Checks if command modifies `readOnlyPaths` (write/edit/delete patterns)
4. Checks if command deletes `noDeletePaths` (delete patterns only)

Returns `{ blocked, reason }`. Path-based checks return `{ blocked, reason }`.

### Config loading (config.ts:loadConfig)

`loadConfig(cwd)` checks 4 files only:
- `.pi/patterns.yaml` — essential rules (shipped, overwritten on install/update)
- `~/.pi/patterns.yaml` — essential rules (shipped, overwritten on install/update)
- `.pi/defender.yaml` — user rules + whitelist (NEVER overwritten)
- `~/.pi/defender.yaml` — user rules + whitelist (NEVER overwritten)

Returns `LoadedConfig`:
- `.config` — merged `Config` from all found sources
- `.sources` — per-file `FileSource[]` with `displayPath`, `found`, and per-category counts

`ensurePatternsConfig(cwd)` copies the bundled defaults to global and local
`patterns.yaml` if missing (idempotent). Called on session_start and by
`/defender:patterns` command.

### Table formatting (config.ts:formatConfigTable / formatStatsTable)

`formatConfigTable(loaded, version, strictMode, disabled, fg?)` builds a Unicode
box-drawing table with columns: Source, Pat, Zero, ROnly, NDel, Wlst.
Shows all 4 sources — found files show per-category counts, unfound files
show "— not found —". Used by session_start, /defender:reload, and /defender:status.

`formatStatsTable(st, sessionApprovedCount, fg?)` builds a 2-column table
(Stat + Cnt). Both functions accept an optional `fg` color function — non-zero
counts are highlighted in accent color. `index.ts` passes `savedTheme.fg.bind(savedTheme)`.

### Whitelist (config.ts)

- **checkWhitelist(command, config)** → `{ matched, pattern }` — tests command against all `strictModeWhiteList` regex patterns
- **generateWhitelistPattern(command)** — extracts tool identity (base command + subcommand for meta-tools like git, npm, npx, docker), strips all parameters/flags/paths/directories, tokenizes respecting quotes, reduces path-prefixed commands to basename, wraps in `^...\b`. For `npm run`/`bun run`/`yarn run`/`pnpm run`, generates a flag-tolerant 3-level pattern (e.g. `^npm run(\s+--?[a-zA-Z][\w-]*)*\s+build\b`). Returns empty string when no script name is found — never falls back to `^npm run\b` because that would approve ALL run commands.
- **generateWhitelistPatterns(command)** — splits chained commands and applies `generateWhitelistPattern` to each
- **addPatternToWhitelist(cwd, pattern)** — reads/creates `.pi/defender.yaml`, appends pattern to `strictModeWhiteList`, writes back. Returns `{ added, reason }`. Auto-creates `.pi/` dir and `defender.yaml` as needed. NEVER writes to `patterns.yaml` (which is overwritten on install).

### Session-approved patterns (index.ts)

When the user selects "⭐ Approve ALL" in strict mode, the command's regex pattern
is added to `sessionApprovedPatterns[]` — an in-memory array (NOT persisted to YAML).
Future Bash commands matching any session-approved pattern are auto-approved for the
remainder of the current prompt.

- **checkSessionApproved(command, patterns)** → `{ matched }` — tests command against session-approved patterns (same logic as `checkWhitelist`)
- Patterns are cleared on `message_start` (new agent turn) and `session_shutdown`
- `/defender:strict on|off|toggle` also clears session-approved patterns
- Displayed in `/defender:status` as "Session-approved patterns: N"
- Different from permanent whitelist: session-approved is temporary, per-prompt, not written to YAML

### Bash handler tiers (index.ts)

Chained commands (`&&`, `||`, `;`) are split via `splitChainCommands()` and each
sub-command is processed individually through the full pipeline:

```
for each subCmd in chain:

1. patterns.yaml BLOCKED → patternBlockedPrompt(ctx, subCmd, reason, stepInfo)
     selector: ⚠️ Allow / ❌ Deny & Abort
   - Allow → skip strict mode for THIS sub-command, continue to next
   - Deny → calls ctx.abort() to cancel agent's turn + sets aborted=true

2. ABORTED STATE → blocks all bash with 🛡️❌ message
   - Also blocks Write/Edit tools (separate handler checks aborted flag)

3. STRICT MODE (ON by default) → whitelist check → session-approved check → strictModePrompt()
     selector: ✅ Approve / 📋 Whitelist / ⭐ Approve All / ⚠️ Deny / ❌ Abort
   - Whitelist check runs first: if subCmd matches strictModeWhiteList pattern → auto-approve
   - Session-approved check: if subCmd matches a previously "Approve All"-ed pattern → auto-approve
   - Whitelist save: generates regex from subCmd, writes to .pi/patterns.yaml, reloads config
   - "Approve All": adds subCmd regex pattern to in-memory sessionApprovedPatterns[]
     — future occurrences of the SAME command auto-approve (cleared on new prompt)
   - Abort → calls ctx.abort() + sets aborted=true
   - Deny or Abort on ANY sub-command → full chain blocked

4. NORMAL MODE → passes through (no UI)

// All sub-commands approved → allow the full chained command to run
```

### Command display format

Both prompts use `formatCommandForDisplay(command, maxWidth?)` (`src/index.ts`) to render the command:
- When `maxWidth` is provided (inside `render(width)`), uses `truncateToWidth()` from `@earendil-works/pi-tui` for ANSI-aware width-based truncation to `width - 2` (accounting for 2-space indent)
- Without `maxWidth` (fallback confirm dialog), truncates at 300 chars
- This prevents Pi crashes from "Rendered line exceeds terminal width" on narrow terminals
- The command text uses **`theme.fg("accent", ...)`** (accent/bold color) to stand out
- A clear **`Command:`** label (also in accent/bold) is shown above the command text
- When approving a sub-command from a chain, a **step indicator** like `(2/3)` appears in the title bar

### Selector UI

Two custom UI prompts using `ctx.ui.custom()`:
- **patternBlockedPrompt(ctx, command, reason, stepInfo?)**: 2 options, yellow/warning theme, shows pattern reason + command in accent
- **strictModePrompt(ctx, command, stepInfo?)**: 5 options, accent theme, shows step info for chain context

Both fall back to `ctx.ui.confirm()` if custom UI unavailable.

### Number key shortcuts

Both selectors support **number key shortcuts** (`1`-`N`) for instant selection.
Each option is prefixed with `[N]` — press the corresponding number to select:
- `1` = first option, `2` = second, etc.
- Works in both pattern-blocked (2 options) and strict mode (5 options) selectors
- Much faster than arrow keys for common actions: press `2` to whitelist, `3` for approve-all
- Footer shows: `↑↓ navigate · 1-N select · enter confirm · esc deny`

### Keyboard input handling

Both selectors import `matchesKey` and `Key` from `@earendil-works/pi-tui` for keyboard
input matching. Raw byte comparisons (`data === "\r"`, `data === "\x1b[A"`) are
NOT used — `matchesKey(data, Key.enter)` and `matchesKey(data, Key.up)` handle both
legacy terminal sequences AND Kitty keyboard protocol CSI-u sequences. This is
essential for VS Code + WSL environments where Kitty protocol is active and Enter
sends `\x1b[13~` instead of legacy `\r`.

Vim-style `k`/`j` navigation is kept as a fallback alongside `matchesKey(data, Key.up/down)`.

Digit input uses `decodeKittyPrintable(data) || data` to handle **both** Kitty
CSI-u protocol (VS Code + WSL) and legacy ASCII terminals. In Kitty protocol,
pressing `1` sends a CSI-u sequence (e.g. `\x1b[49~`) instead of raw ASCII `1`.
`decodeKittyPrintable()` decodes it back to `"1"`; in legacy mode it returns
`undefined` and `data` (the raw ASCII byte) is used as fallback.

### Theme saving

Both prompts save `savedTheme = theme` in their `ctx.ui.custom()`
callbacks. This is critical — `savedTheme` is used throughout the Bash handler for
notification formatting. If either prompt runs without saving, `savedTheme` remains
`null` and the handler crashes mid-loop on `savedTheme.fg()` calls, causing subsequent
chain selectors to be skipped.

### Chained command processing

When a bash command contains chain separators (`&&`, `||`, `;`), `splitChainCommands()` from `config.ts` breaks it into individual sub-commands. Each sub-command is then processed independently through `checkCommand()` + `patternBlockedPrompt()` + `strictModePrompt()`. All sub-commands must be approved for the full chain to execute.

A **150ms delay** runs between sub-command selectors to prevent TUI race conditions — without it, the second `ctx.ui.custom()` call may conflict with the first selector's teardown and never render.

**Whitelist batching**: All sub-command decisions are collected during the loop and shown as a single unified notification — same format for single or chain commands:

```
🛡️🔒 Strict Mode
  ✅ Approved: mkdir -p test2
  📋 Whitelisted: touch ./test2/text.md
  ✅ Approved: ls -la ./test2
```

- `✅ Approved` for manually approved or approve-all-delegated commands
- `📋 Whitelisted` for whitelist-matched or user-chosen whitelist-saved commands
- Commands truncated to 35 chars, rendered in accent color

## Commands

| Command | Handler |
|---|---|
| `/defender:status` | Shows stats + config table |
| `/defender:reload` | Clears cached config, reloads from YAML, shows table |
| `/defender:patterns` | Copies bundled essential patterns to `.pi/patterns.yaml` (idempotent) |
| `/defender:strict [on\|off]` | Toggles strict mode (ON by default, resets session-approved/aborted) |

## When editing patterns

1. Edit `src/patterns.yaml` — bundled defaults shipped with the package
2. The file is deployed to `.pi/` on install and via `/defender:patterns`
3. Run `/defender:reload` to apply changes in-session
4. User customizations go in `.pi/defender.yaml` (never overwritten on update)

## Pi API surface used

- `pi.on("session_start", handler)` — session lifecycle
- `pi.on("session_shutdown", handler)` — cleanup
- `pi.on("tool_call", handler)` — intercept tool calls, return `{ block: true, reason }` or `undefined`
- `pi.registerCommand(name, { description, handler })` — slash commands
- `ctx.ui.notify(message, "info"|"warning"|"error")` — status messages
- `ctx.ui.confirm(title, message)` → `boolean` — yes/no prompts
- `ctx.ui.custom(callback)` → `T` — custom TUI components (SelectList-style)
- `ctx.hasUI` → `boolean` — TUI availability
- `ctx.cwd` → `string` — working directory

## Instructions

- after apdate to any `*.ts` file, update `README.md` and `CHANGELOG.md` and `AGENTS.md`
