# Pi Defender — Agent Context

## Overview

Pi Defender is a Pi coding agent extension that provides defense-in-depth protection — intercepts tool calls (Bash, Write, Edit, Read) and blocks or prompts the user before dangerous operations.

**Entry point:** `src/index.ts` — exports a default function `(pi: ExtensionAPI) => void`.

## Architecture

```
src/
├── index.ts      # Extension entry: event handlers, commands, strict mode logic,
│                 #   showModeSelector (reusable protection-level selector),
│                 #   applyMode helper
├── config.ts     # Pattern matching, path checking, YAML config loading + merging,
│                 #   changelog parsing (reads bundled CHANGELOG.md), version tracking
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
    → **version check**: reads `~/.pi/defender-version` (plain text file with
      last-seen version string) via `readLastSeenVersion()`. Compares against
      DEFENDER_VERSION. On upgrade (or first run), reads bundled CHANGELOG.md
      from disk (tries dev and installed paths), extracts entries between
      lastSeen and current via `getChangelogDiff()`, sends the changelog as
      a user message via `pi.sendUserMessage()` (rendered as markdown by the
      chat UI), and writes the new version to `~/.pi/defender-version` via
      `writeLastSeenVersion()`.
    → checks `defaultMode` from merged config:
      - If set (and not "interactive"), skips the selector entirely
        and applies the mode directly (strict/patterns/off)
      - Shows config table notification for strict/patterns modes;
        shows brief "DISABLED" notification for off mode
    → If no defaultMode or "interactive", calls showModeSelector() — a reusable
      async function that renders the protection-level selector. Also used by
      /defender:default-mode (no args). After selection, displays a config table breaking down which rules
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
- **promptTimeout**: seconds before strict-mode prompt auto-dismisses (0/undefined = no timeout). Bundled default: 120
- **autoApprove**: false = auto-deny on timeout (default), true = auto-approve. Applies only to strict mode selector
- **strictModeWhiteList**: regex patterns — commands matching these skip strict mode prompts

### Pattern matching (config.ts:checkCommand)

1. Strips `#`-prefixed comment lines from the command via `stripCommentLines()` before any pattern matching
2. Tests `bashToolPatterns` regex against the stripped bash command string
3. Checks if command references `zeroAccessPaths` (any operation)
4. Checks if command modifies `readOnlyPaths` (write/edit/delete patterns)
5. Checks if command deletes `noDeletePaths` (delete patterns only)

Returns `{ blocked, reason }`. Path-based checks return `{ blocked, reason }`.

### Default mode (config.ts)

`defaultMode` is an optional top-level config key (in any YAML file) that
skips the session-start interactive selector and goes directly to the
specified mode. Values: `strict` (🔒 Strict ON), `patterns` (🛡️ Patterns only),
`off` (⚪ Disable Defender), `interactive` (show selector — same as omitting).

When merged across multiple files, uses **first-wins** semantics (the first
non-undefined value wins). `getConfigPaths()` loads local `.pi/defender.yaml`
before global `~/.pi/defender.yaml`, so project-local settings always override
global ones. Typically placed in `.pi/defender.yaml` (user, never overwritten)
to persist across updates.

**setDefaultMode(cwd, mode, global_)** — Helper in config.ts that writes
`defaultMode` to either `.pi/defender.yaml` (local) or `~/.pi/defender.yaml`
(global). Creates the file and directory if needed, preserving existing keys.
Writes `defaultMode` as the **first key** in the file, followed by a blank line
before any remaining content (whitelist patterns, etc.). Returns
`{ success, path, reason? }`. Used by the session-start selector save
options and the `/defender:default-mode` command.

### Prompt timeout (config.ts)

`promptTimeout` and `autoApprove` are optional top-level config keys that control
strict mode prompt auto-dismissal. Bundled defaults: `promptTimeout: 120`,
`autoApprove: false` (auto-deny, secure-by-default).

When merged across multiple files, uses **last-wins** semantics (reverse scan,
first non-undefined value wins). This ensures user `defender.yaml` (never
overwritten) always overrides shipped `patterns.yaml` defaults.

These apply ONLY to the strict mode selector (`strictModePrompt`).
`patternBlockedPrompt` is never timed — security-critical blocks (`rm -rf`,
`sudo`, secrets access) must always require explicit user action.

Timeouts are ignored when:
- Strict Mode is OFF (no prompts fire)
- `promptTimeout` is 0 or undefined
- TUI is unavailable (falls back to `ctx.ui.confirm()` which has no timeout API)

### Version tracking (config.ts)

**Version state file** — `~/.pi/defender-version` is a plain text file containing
just the version string (e.g. "1.8.0"). Clean, no YAML, separate from rule config.

**CHANGELOG.md bundling** — The file is bundled with the npm package (removed
from `.npmignore`). At runtime, `readChangelog()` tries two paths:
- `join(__dirname, "..", "CHANGELOG.md")` — dev mode (`src/` → project root)
- `join(__dirname, "..", "..", "CHANGELOG.md")` — installed (`dist/src/` → package root)
No template literal embedding — the actual file is shipped and read at runtime.

**semverCmp(a, b)** — Simple semver comparator (x.y.z), strips leading "v".

**parseChangelogVersions(changelog)** → `Map<version, entry>` — Parses changelog:
splits on `## [vX.Y.Z]` headers, extracts content between headers.

**getChangelogDiff(currentVersion, lastSeenOrNewest)** → `string | null` —
Extracts changelog entries for versions > lastSeenVersion and ≤ currentVersion.
On first run (no lastSeenVersion), returns only the current version's entry.
Returns null if CHANGELOG.md not found or no new versions exist.

**readLastSeenVersion()** → `string | undefined` — Reads version from
`~/.pi/defender-version`. Returns undefined if file doesn't exist.

**writeLastSeenVersion(version)** — Writes version string to
`~/.pi/defender-version`. Creates dir/file if needed. Errors silently ignored.

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

- **checkWhitelist(command, config)** → `{ matched, pattern }` — tests command against all `strictModeWhiteList` regex patterns. Strips `#`-prefixed comment lines via `stripCommentLines()` before matching, so commands like `# comment\nssh root@...` match whitelist patterns written for just `ssh`.
- **stripCommentLines(command)** → removes lines that start with `#` after optional whitespace (whole-line comments only — inline comments mid-line are preserved). Applied in `checkWhitelist()`, `checkSessionApproved()`, `checkCommand()`, and `splitChainCommands()`.
- **generateWhitelistPattern(command)** — extracts tool identity (base command + subcommand for meta-tools like git, npm, npx, docker), strips all parameters/flags/paths/directories, tokenizes respecting quotes, reduces path-prefixed commands to basename, wraps in `^...\b`. For `npm run`/`bun run`/`yarn run`/`pnpm run`, generates a flag-tolerant 3-level pattern (e.g. `^npm run(\s+--?[a-zA-Z][\w-]*)*\s+build\b`). Returns empty string when no script name is found — never falls back to `^npm run\b` because that would approve ALL run commands.
- **generateWhitelistPatterns(command)** — splits chained commands and applies `generateWhitelistPattern` to each
- **addPatternToWhitelist(cwd, pattern)** — reads/creates `.pi/defender.yaml`, appends pattern to `strictModeWhiteList`, writes back. Returns `{ added, reason }`. Auto-creates `.pi/` dir and `defender.yaml` as needed. NEVER writes to `patterns.yaml` (which is overwritten on install).
- **mergeWhitelistToGlobal(cwd)** — compares local `.pi/defender.yaml` and global `~/.pi/defender.yaml` whitelists. Copies any patterns from local that don't exist in global to the global file. Returns `{ added, skipped, reason }`. Used by `/defender:globalize-whitelist`.

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
sub-command is processed individually through the full pipeline.
Bash line continuation (`\<newline>`) is silently consumed (not added to sub-commands):

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
   - **Timeout**: prompt auto-dismisses after `promptTimeout` seconds (default 120). `autoApprove` controls the action (default: deny). A live countdown is shown in the TUI footer. Pattern-blocked prompts are NEVER timed.
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

### Render safety — line truncation

ALL three custom TUI render functions (session-start selector, `patternBlockedPrompt`,
`strictModePrompt`) apply `truncateToWidth(l, width)` to every line via
`return lines.map(l => truncateToWidth(l, width))`. This is a defense-in-depth
measure — every rendered line is truncated to the terminal width before being
returned to the TUI framework. Without it, any line (hint text, reason text,
description text) that accidentally exceeds the terminal width crashes Pi
with `"Rendered line N exceeds terminal width (X > Y)"`.

Additionally, the hint line in `strictModePrompt` and the reason line in
`patternBlockedPrompt` are explicitly truncated before being added to the lines
array — both can exceed typical terminal widths with long text.

### Selector UI

Two custom UI prompts using `ctx.ui.custom()`:
- **patternBlockedPrompt(ctx, command, reason, stepInfo?)**: 2 options, yellow/warning theme, shows pattern reason + command in accent
- **strictModePrompt(ctx, command, stepInfo?, promptTimeout?, autoApprove?)**: 5 options, accent theme, shows step info for chain context. When `promptTimeout > 0`, shows a live countdown in the TUI footer (`⏳ Will auto-deny in 45s...`) and auto-dismisses when the timer fires. Timeout and interval are cleaned up on any user input or component dispose.

Both fall back to `ctx.ui.confirm()` if custom UI unavailable.

### Number key shortcuts

Both selectors support **number key shortcuts** (`1`-`N`) for instant selection.
Each option is prefixed with `[N]` — press the corresponding number to select:
- `1` = first option, `2` = second, etc.
- Works in both pattern-blocked (2 options) and strict mode (5 options) selectors
- Much faster than arrow keys for common actions: press `2` to whitelist, `3` for approve-all
- Footer shows: `↑↓ navigate · 1-N select · enter confirm · esc deny` (or `⏳ Will auto-deny in Ns...` when timeout is active)

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

When a bash command contains chain separators (`&&`, `||`, `;`), `splitChainCommands()` from `config.ts` breaks it into individual sub-commands — but only separators OUTSIDE string literals (single-quoted, double-quoted, backtick-quoted). Escaped separators (`\;`, `\&&`, `\||`) are preserved as literal content. Bash line continuation (`\<newline>` and `\<\r\n>`) is silently consumed — neither the backslash nor the newline is added to any sub-command. This prevents false splits when multi-line inline code (e.g. `bun -e "..."`) contains semicolons inside quoted strings, and prevents stray backslashes from appearing at the start of sub-commands after `&& \<newline>` continuations. Each sub-command is then processed independently through `checkCommand()` + `patternBlockedPrompt()` + `strictModePrompt()`. All sub-commands must be approved for the full chain to execute.

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
| `/defender:status` | Shows stats + config table + defaultMode status |
| `/defender:reload` | Clears cached config, reloads from YAML, shows table |
| `/defender:patterns` | Copies bundled essential patterns to `.pi/patterns.yaml` (idempotent) |
| `/defender:strict [on\|off]` | Toggles strict mode (ON by default, resets session-approved/aborted) |
| `/defender:default-mode` | Set/reset default mode (skip session-start selector). No args = launch protection-level selector (same as session startup). Args: `strict`/`patterns`/`off`/`interactive` (+ optional `--local` for project-scoped) |
| `/defender:globalize-whitelist` | Copies unique local whitelist patterns from `.pi/defender.yaml` to `~/.pi/defender.yaml` |
| `/defender:report-issue <description>` | AI-powered: analyzes raw message (bug/feature), enhances description, creates GitHub issue via custom tool (REST API, no gh CLI needed) |

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
- `pi.registerTool(definition)` — custom tools callable by the LLM (e.g., `pi_defender_create_issue` for GitHub REST API)

## Important restrictions

- **`pi_defender_create_issue`** is EXCLUSIVELY for `/defender:report-issue`. It creates issues ONLY on `Serhioromano/pi-defender`. NEVER use it to create issues on other repositories — use `gh issue create` or the GitHub MCP tools instead. NEVER call this tool unless the user explicitly invoked `/defender:report-issue` or the follow-up message from that command explicitly instructs the agent to call it.
- `pi.sendUserMessage(content, options?)` — queue user messages for the agent in follow-up turns
- `ctx.hasUI` → `boolean` — TUI availability
- `ctx.cwd` → `string` — working directory

## Instructions

- after apdate to any `*.ts` file, update `README.md` and `CHANGELOG.md` and `AGENTS.md`
