# Changelog

All notable changes to Pi Defender will be documented in this file.

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
