# Changelog

All notable changes to Pi Defender will be documented in this file.

## [v1.3.0]

- `fix` - Enter key not working in WSL with Kitty keyboard protocol
- `improve` - Chain command: approve or whitelist every command in the chain separately. Commands joined with `&&`, `||`, or `;` are split into individual sub-commands and each goes through the full approval pipeline independently.
- `improve` - Command display improvements** in both strict mode and patterns.yaml prompts:

## [v1.2.6]

### Changed
- **Strict mode is now ON by default**. When Defender activates (session start or first tool call), strict mode is active immediately, requiring user approval for every bash command. Use `/defender:strict off` to disable.
- All notification messages updated to reflect strict-mode-by-default: session start, reload, status command, and strict mode toggle messages now show "(default)" when active and "(non-default)" when off.
- `/defender:status` now shows `🔒 ACTIVE (default)` when strict mode is on and `⚪ OFF (non-default)` when off.
- `strictModePrompt()` selector now has 5 options (added "Allow & Whitelist")
- Strict mode activation notification updated to mention the whitelist option
- **Deny/Abort now truly stops execution**: When user selects "Deny" on a patterns.yaml block or "Abort" in strict mode, `ctx.abort()` is now called to cancel the agent's turn, preventing it from trying alternative approaches (different bash commands, Write/Edit bypasses, etc.). Previously only future bash commands were blocked, but the agent could still use Write/Edit/Read tools or try different bash commands in the same reasoning loop.
- **Write/Edit blocked during abort state**: The Write/Edit tool handler now checks the `aborted` flag and blocks all file operations when execution is aborted. Previously the abort state only affected bash commands, allowing the agent to bypass via Write/Edit.

### Added
- **Strict Mode Whitelist**: New 📋 "Allow & Whitelist" option in the strict mode selector. When selected, saves a regex pattern for the approved command to `.pi/patterns.yaml` under `strictModeWhiteList`. Future runs of the same command are auto-approved — no prompt needed.
  - Whitelist check runs before the strict mode prompt — matching commands skip the selector entirely
  - Pattern is generated from the command string (regex-special chars escaped)
  - `.pi/patterns.yaml` is auto-created if it doesn't exist
  - Duplicate patterns are detected and not re-added
  - Notification shows the matched pattern when whitelist is applied
  - Config is reloaded immediately after saving so the pattern takes effect in the same session
- New `strictModeWhiteList` section in `patterns.yaml` — array of JS regex patterns
- New functions in `config.ts`: `checkWhitelist()`, `generateWhitelistPattern()`, `addPatternToWhitelist()`
- `/defender:status` now shows whitelist pattern count

## [1.0.6]

### Added
- **Auto-deploy of bundled defaults**: On first session start, the default `patterns.yaml` is automatically written to `~/.pi/pi-defender/patterns.yaml` if it doesn't already exist. This ensures the bundled patterns are always discoverable, solving the `dist/` compilation issue where `src/patterns.yaml` was not copied to the output directory.
- Embedded `DEFAULT_PATTERNS_YAML` constant in `config.ts` — the full default patterns live in code as a template literal, eliminating runtime dependency on finding the YAML file on disk.
- New `ensureGlobalConfig()` function in `config.ts` that idempotently deploys defaults to `~/.pi/pi-defender/patterns.yaml`.
- Additional fallback path in `getConfigPaths`: `__dirname/../src/patterns.yaml` (handles compiled `dist/` layout).
- **Strict Mode** (`/defender:strict`): Block ALL bash tool execution requiring explicit user approval per command
  - Interactive selector UI with 4 options:
    - ✅ **Approve** — run this command once
    - ⚠️ **Deny (try something else)** — block, agent can try alternative
    - ⭐ **Approve All Session** — auto-approve safe commands (patterns.yaml blocked rules still enforced)
    - ❌ **Abort (stop all execution)** — block command + lock all future bash until reset
  - Abort state persists across commands — must use `/defender:strict off` to reset
  - `approveAllSession` flag auto-approves safe commands (patterns.yaml blocked rules still enforced)
  - Toggle with `on|off` or no parameter to toggle
  - 🛡️🔒 emoji badge when active, 🛡️❌ when aborted
  - Fallback to two-step confirm dialog when custom UI unavailable
  - No-UI mode: blocks all bash commands with clear error message
- New stats tracked: `strictApproved`, `strictBlocked`, `strictApprovedAll`
- `/defender:status` now shows strict mode state, abort state, and per-mode statistics

### Fixed
- Compilation issue: `patterns.yaml` was not copied to `dist/` by TypeScript (`tsconfig.json` only includes `*.ts` files). The `__dirname`-based path resolution would fail at runtime because `__dirname` pointed to `dist/` instead of `src/`. Now fixed via the auto-deploy + embedded YAML approach.

### Changed
- `import` statement in `index.ts` now imports `ensureGlobalConfig` from `./config`.
- `session_start` handler now calls `ensureGlobalConfig()` before loading config.
- **`src/patterns.yaml` is now the single source of truth** for all default patterns
  - Removed hardcoded `DEFAULT_BASH_PATTERNS`, `DEFAULT_ZERO_ACCESS`, etc. from `index.ts`
  - Bundled YAML parsed at init via `getBundledDefaults()` — patterns stay in one place
  - `/defender:patterns` copies the source file directly instead of using a separate template string
- **patterns.yaml matches no longer auto-block** — instead shows a selector:
  - ⚠️ **Allow anyway** — run the dangerous command, skip further checks
  - ❌ **Deny & Abort** — stop entire prompt, lock all future bash until reset
- Notification messages now explicitly mention "patterns.yaml" as the source of the block
- Bash tool_call handler restructured with 4-tier logic: patterns → aborted → strict → normal
- `README.md` Configuration section updated to document auto-deploy behavior and merged config loading.

## [1.1.0] - 2024

### Added
- Initial release (ported from `pi-damage-control`)
- Bash command protection with regex patterns
- Path protection: zeroAccess, readOnly, noDelete levels
- Ask mode for destructive-but-valid commands
- YAML configuration (project-local and global)
- Commands: `/defender:status`, `/defender:reload`, `/defender:patterns`
