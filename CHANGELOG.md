# Changelog

All notable changes to Pi Defender will be documented in this file.

## [v1.4.0]

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
