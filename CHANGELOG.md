# Changelog

All notable changes to Pi Defender will be documented in this file.

## [Unreleased]

### Added
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

### Changed
- **`src/patterns.yaml` is now the single source of truth** for all default patterns
  - Removed hardcoded `DEFAULT_BASH_PATTERNS`, `DEFAULT_ZERO_ACCESS`, etc. from `index.ts`
  - Bundled YAML parsed at init via `getBundledDefaults()` — patterns stay in one place
  - `/defender:patterns` copies the source file directly instead of using a separate template string
- **patterns.yaml matches no longer auto-block** — instead shows a selector:
  - ⚠️ **Allow anyway** — run the dangerous command, skip further checks
  - ❌ **Deny & Abort** — stop entire prompt, lock all future bash until reset
- Notification messages now explicitly mention "patterns.yaml" as the source of the block
- Bash tool_call handler restructured with 4-tier logic: patterns → aborted → strict → normal

## [1.1.0] - 2024

### Added
- Initial release (ported from `pi-damage-control`)
- Bash command protection with regex patterns
- Path protection: zeroAccess, readOnly, noDelete levels
- Ask mode for destructive-but-valid commands
- YAML configuration (project-local and global)
- Commands: `/defender:status`, `/defender:reload`, `/defender:patterns`
