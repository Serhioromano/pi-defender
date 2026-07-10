# Changelog

All notable changes to Pi Defender will be documented in this file.

## [v1.8.0]

- `add` - default mode. Allows user to save Defender Mode globaly or localy and avoid popup every time pi starts.
- `fix` - **Whitelist matching now ignores shell comment lines (#12)**: Commands prefixed with `#` comment lines (e.g. `# Test login\nssh root@...`) no longer break whitelist pattern matching. A new `stripCommentLines()` helper removes lines that start with `#` (after optional whitespace) before matching against whitelist patterns, session-approved patterns, and bashToolPatterns. Also applied in `splitChainCommands()` so chained sub-commands are comment-free. Inline comments (where `#` appears mid-line) are preserved since they don't affect `^...\b`-based pattern matching.

## [v1.7.4]

- `add` - **"Save my choice" in session-start selector**: The session-start selector now includes two save options: 💾 Save choice for this project (writes `defaultMode` to `.pi/defender.yaml`) and 🌐 Save choice forever (global) (writes to `~/.pi/defender.yaml`). This converts the selector into a self-discovering onboarding flow — users can persist their preference without ever reading the README. The save options remember the last-highlighted mode, so you can navigate to a mode, then down to save. Save options are rendered dimmed when a mode option is highlighted, and highlighted when selected. Number key shortcuts `4` and `5` work for the save options.
- `add` - **`/defender:default-mode` command**: New slash command to set or reset the default mode from the Pi session. Usage:
  - `/defender:default-mode` — shows current default mode + usage help
  - `/defender:default-mode strict` — 🔒 Strict ON (global)
  - `/defender:default-mode patterns` — 🛡️ Patterns only (global)
  - `/defender:default-mode off` — ⚪ Disable defender (global)
  - `/defender:default-mode interactive` — reset (show selector again)
  - `/defender:default-mode strict --local` — project-local (`.pi/defender.yaml`)
- `add` - **`/defender:status` shows defaultMode**: Status output now includes a line showing the current `defaultMode` setting (or "not set" if the selector is shown each session).
- `add` - **`setDefaultMode()` helper (config.ts)**: New exported function that writes `defaultMode` to either `.pi/defender.yaml` or `~/.pi/defender.yaml`. Creates the file and directory if needed, preserving existing keys. Used by the selector save options and the `/defender:default-mode` command.
- `add` - **`defaultMode` config option**: Add `defaultMode` to any `defender.yaml` or `patterns.yaml` to skip the session-start interactive selector and go directly to your preferred mode. Values: `strict` (🔒 Strict Mode ON), `patterns` (🛡️ Patterns only), `off` (⚪ Disable Defender), `interactive` (show the selector — same as omitting the key). Merged across all config files with **first-wins semantics** (project-local `.pi/defender.yaml` overrides global `~/.pi/defender.yaml`). When a non-interactive mode is set, the config table notification is shown instead of the selector.
- `fix` - **Project-local defaultMode now wins over global**: `defaultMode` uses first-wins semantics (local `.pi/defender.yaml` is checked before global `~/.pi/defender.yaml`), so a project-specific setting always overrides the global default. Previously the global config would always override due to last-wins merging.
- `fix` - **defaultMode fast path no longer crashes on theme deref**: The new module-level `fg()` helper is used everywhere instead of direct `savedTheme.fg(...)`. When the session-start fast path (defaultMode set) skips the interactive selector, `savedTheme` remains null — but subsequent `/defender:strict off` or whitelist notifications now use the safe accessor and degrade to plain text instead of crashing.
- `fix` - **setDefaultMode() crash on empty or scalar defender.yaml**: `parseYaml("")` returns `null`, and `parseYaml("42")` returns a number — both would crash when writing `.defaultMode`. The helper now normalises to a plain `{}` when the parsed value is null, a scalar, or an array.
- `fix` - **feedback.md no longer ships in npm package**: Added to `.npmignore`.

## [v1.7.3]

- `fix` - **Harden `pi_defender_create_issue` tool against misuse**: The tool is EXCLUSIVE to `/defender:report-issue` and creates issues only on `Serhioromano/pi-defender`. Updated tool `description`, `promptGuidelines`, `promptSnippet`, and `AGENTS.md` to explicitly forbid using this tool for any other repository or purpose. AI agents must use `gh issue create` CLI for issues on other repos.

## [v1.7.1]

- `docs` - **README overhaul**: Cut from ~350 lines to ~120. Removed implementation details already covered in `AGENTS.md` (selector internals, chain splitting algorithms, TUI rendering safety, keyboard protocol handling, theme saving mechanics, session-approved pattern lifecycle). Replaced with scannable feature descriptions, quick-start install, essential commands, and a minimal config example. Focused on what an end user actually needs.

## [v1.7.0]

- `add` - **`/defender:report-issue` command + `pi_defender_create_issue` tool (#7)**: AI-powered issue reporting that works without `gh` CLI. The command accepts a raw description, collects diagnostics (version, stats, config table), then uses `pi.sendUserMessage()` to delegate to the AI. The AI analyzes the message (detects bug vs feature), enhances title/description, and calls the `pi_defender_create_issue` custom tool — which uses `fetch()` to call the GitHub REST API directly. Token resolution is multi-source: `GH_TOKEN`/`GITHUB_TOKEN` env vars → `gh auth token` → `~/.config/gh/hosts.yml` parsing. Registers the tool during extension load so it's always available to the LLM.

- `add` - **`/defender:globalize-whitelist` command (#6)**: Copies unique local whitelist patterns from `.pi/defender.yaml` to `~/.pi/defender.yaml`, so patterns approved in one project become available globally. Compares both files, skips duplicates, and reloads config after writing. Includes `mergeWhitelistToGlobal(cwd)` in `config.ts` with internal helpers `readWhitelistFromFile()` and `addPatternsToDefenderFile()` that work with arbitrary defender.yaml paths (not just the project-local one).

## [v1.6.5]

- `fix` - **Bash line continuation `\` breaks chain splitting (#5)**: `splitChainCommands()` now detects bash line continuation (`\` followed by newline) and silently consumes both characters without adding them to `current`. Previously the `\` fell through to the generic escape handler which kept both the backslash and the newline byte in the command text — after `trim()` the newline was stripped but the leading `\` remained, making every sub-command after a line continuation start with a stray backslash. Also handles Windows-style `\r\n` line endings.

## [v1.6.4]

- `fix` - **Shell-aware command chain splitting (#3)**: `splitChainCommands()` no longer naively splits on `&&`, `||`, `;` — it now tracks single-quote, double-quote, and backtick string literals, preserving chain separators inside them. Escaped separators (`\;`, `\&&`, `\||`) are also kept as literal content. Fixes false splits when multi-line inline code (e.g. `bun -e "..."`) contains semicolons or other chain separators inside quoted strings.

## [v1.6.3]

- `fix` - **Truncate all rendered lines to terminal width**: All three TUI render functions (session-start selector, `patternBlockedPrompt`, `strictModePrompt`) now apply `truncateToWidth(l, width)` to every rendered line via `.map()`. The specific trigger was the hint line in `strictModePrompt` ("Run  /defender:strict off to turn Strict Mode off and stop these prompts to popup.") which was 84 visible chars on an 82-char terminal. The hint text was also shortened ("to popup" → ""). Additionally, the reason line in `patternBlockedPrompt` is explicitly truncated to prevent overflows from long pattern reasons.

## [v1.6.2]

- `add` - **3-level whitelist patterns for `npm run` / `bun run` with flag-tolerant gap**: `generateWhitelistPattern` now captures the script name when the sub-command is `run`, with a flag-tolerant gap between `run` and the script name. Previously `npm run build` generated `^npm run\b` (2-level), now it generates `^npm run(\s+--?[a-zA-Z][\w-]*)*\s+build\b`. **No fallback** — `npm run` (without a script name) returns empty string, because `^npm run\b` would auto-approve ALL run commands. Flags like `--if-present`, `-s`, `--silent` between `run` and the script are tolerated. Applies to `npm`, `yarn`, `pnpm`, and `bun`.
  - `npm run build` → `^npm run(\s+--?[a-zA-Z][\w-]*)*\s+build\b`
  - `npm run --if-present build` → same pattern (flags tolerated)
  - `npm run` → `""` (no pattern — would be dangerous)

## [v1.6.1]

- `add` - **Accent-colored numbers in tables**: `formatConfigTable` and `formatStatsTable` now highlight non-zero counts with accent color. Both functions accept an optional `fg` color function parameter; `index.ts` passes `savedTheme.fg`. Zero values remain plain.

## [v1.6.0]

- `add` - **Config table on session start**: The session-start notification now shows a Unicode box-drawing table with per-file rule counts instead of a single-line summary. The table breaks down which rules come from which source:
  - **`.pi/patterns.yaml`** — essential rules (shipped, overwritten on install)
  - **`~/.pi/patterns.yaml`** — essential rules (global, overwritten on install)
  - **`.pi/defender.yaml`** — user rules + whitelist (NEVER overwritten)
  - **`~/.pi/defender.yaml`** — user rules + whitelist (global, NEVER overwritten)
  - **`TOTAL (merged)`** row shows the merged result of all 4 sources
  - Columns: **Pat** (patterns), **Zero** (zero-access paths), **ROnly** (read-only), **NDel** (no-delete), **Wlst** (whitelist)
  - Unfound config files show `— not found —` instead of empty rows
  - Applied to all session-start modes (strict, patterns-only, disabled), `/defender:reload`, and `/defender:status`
- `add` - **`defender.yaml` — separate user config file**: Whitelist entries and custom patterns are now saved to `.pi/defender.yaml` instead of `.pi/patterns.yaml`. The `defender.yaml` file is NEVER overwritten on install/update, so your customizations survive. `patterns.yaml` is always overwritten with the latest bundled essential rules on install.
- `add` - **`/defender:patterns` command**: Deploys the bundled essential patterns to `.pi/patterns.yaml` (idempotent). Previously documented but never implemented.
- `add` - **`ensurePatternsConfig()` (config.ts)**: Deploys bundled defaults to `~/.pi/patterns.yaml` and `.pi/patterns.yaml` on first session start if missing. Handles manual installations where npm `postinstall` didn't run.
- `change` - **Runtime only reads `.pi/` directories**: `loadConfig()` no longer reads from `src/patterns.yaml`, `dist/patterns.yaml`, or `node_modules/.../patterns.yaml`. Only the 4 `.pi/` config files are loaded at runtime.
- `change` - **`loadConfig()` returns `LoadedConfig`** with 4 `FileSource` entries (no "bundled" row). Removed `deduplicateSources()` — no longer needed.
- `change` - **`formatConfigTable()`**: Wider source column (24 chars), shows all 4 sources, border aligned to 60 chars.
- `change` - **`/defender:status` includes config table** alongside stats summary.

## [v1.4.2]

- `change` - **Whitelist patterns now extract only tool identity**: When whitelisting a command via 📋 "Allow & Whitelist", the generated regex pattern now strips all parameters, flags, paths, and directories — keeping only the base command and subcommand. Previously the entire literal command was escaped as-is. Examples:
  - `find . -name "*.ts"` → `^find\b` (was: `find \. -name "\*\.ts"`)
  - `git diff HEAD~1` → `^git diff\b` (was: `git diff HEAD~1`)
  - `npx tsc --noEmit` → `^npx tsc\b` (was: `npx tsc --noEmit`)
  - Meta-commands (git, npm, npx, docker, kubectl, etc.) include subcommand; simple commands (find, grep, ls, cat, curl) include only the base command
  - Command names with path prefixes (`/usr/bin/curl`) are reduced to basename (`curl`)
- `add` - **Tokenize bash commands** respecting single/double quotes for reliable tool identity extraction
- `improve` - **Whitelist notification shows regex pattern** underneath each whitelisted command, indented and in `mdLink` color
- `add` - **Session-start protection selector**: On every new session, a selector appears asking: 🔒 Strict Mode ON, 🛡️ Patterns only, or ⚪ Disable Defender. Captures TUI theme early → fixes missing colors in whitelist-only notifications.
- `add` - **Disable Defender** option: selecting ⚪ Disable Defender sets `defenderDisabled = true`, which skips ALL `tool_call` analysis entirely (bash, write, edit, read) — no checks, no notifications. Re-enable with `/defender:strict on`.
- `fix` - **Session-start selector keyboard**: Fixed `handleKey` → `handleInput` (correct Pi TUI API) + added `_tui.requestRender()` for arrow key navigation.
- `fix` - **Null theme crash** when ALL commands in a chain are whitelisted (no prompt fires → `savedTheme` stays null). Theme wrappers now defer lookup to call time via arrow functions.

## [v1.3.2]

- `fix` - **TUI crash when command exceeds terminal width** (#3): Commands longer than the terminal width caused Pi to crash with "Rendered line exceeds terminal width". Fixed by using `truncateToWidth()` from `@earendil-works/pi-tui` in `formatCommandForDisplay()` — both `patternBlockedPrompt` and `strictModePrompt` render functions now truncate commands to `width - 2` (accounting for the 2-space indent) using ANSI-aware width measurement.

## [v1.3.1]

- `fix` - **"Approve All" now scoped to current command** (#2): Previously selecting "⭐ Approve ALL session" set a global boolean that auto-approved ALL subsequent bash commands, effectively disabling strict mode. Now it works as a session-scoped whitelist — only auto-approves future occurrences of the SAME command during the current prompt. Session-approved patterns are cleared on each new prompt (`message_start`) and session shutdown.
- `improve` - **Session-approved patterns shown in status**: `/defender:status` now displays the count of active session-approved patterns.
- `improve` - **Clearer "Approve All" UI text**: Now reads "⭐ Approve ALL (auto-approve future occurrences of THIS command)" to clearly indicate per-command scope.

## [v1.3.0]

- `add` - **Number key shortcuts** in both selectors (patterns.yaml & strict mode). Press `1`-`N` to select an option directly — faster than arrow navigation.
- `fix` - Enter key not working in WSL with Kitty keyboard protocol
- `improve` - Chain command: approve or whitelist every command in the chain separately. Commands joined with `&&`, `||`, or `;` are split into individual sub-commands and each goes through the full approval pipeline independently.
- `improve` - Command display improvements** in both strict mode and patterns.yaml prompts:
- `fix` - **Info messages lost for chained commands** (#1): `ctx.ui.notify()` calls from earlier sub-commands in a chain were immediately overwritten by later ones. Now ALL sub-command decisions are collected and shown in a single combined notification with per-command status indicators (✅ whitelisted, 📋 whitelist-saved, ⭐ approve-all).
- `fix` - **savedTheme crash**: `savedTheme` was only set in `patternBlockedPrompt`'s callback, causing `TypeError` when `strictModePrompt` ran first. Fixed by saving theme in both prompts.

## [v1.2.6]

### Changed

- **Strict mode is now ON by default**. When Defender activates (session start or first tool call), strict mode is active immediately, requiring user approval for every bash command. Use `/defender:strict off` to disable.
- **Deny/Abort now truly stops execution**: When user selects "Deny" on a patterns.yaml block or "Abort" in strict mode, `ctx.abort()` is now called to cancel the agent's turn, preventing it from trying alternative approaches (different bash commands, Write/Edit bypasses, etc.). Previously only future bash commands were blocked, but the agent could still use Write/Edit/Read tools or try different bash commands in the same reasoning loop.
- **Write/Edit blocked during abort state**: The Write/Edit tool handler now checks the `aborted` flag and blocks all file operations when execution is aborted. Previously the abort state only affected bash commands, allowing the agent to bypass via Write/Edit.

### Added

- **Strict Mode Whitelist**: New 📋 "Allow & Whitelist" option in the strict mode selector. When selected, saves a regex pattern for the approved command to `.pi/patterns.yaml` under `strictModeWhiteList`. Future runs of the same command are auto-approved — no prompt needed.
