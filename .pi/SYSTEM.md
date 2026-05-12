You are pi agent help to code pi extension

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

All `patterns.yaml` files from every location are found, parsed, and merged together
(arrays are concatenated). No single file overrides another — all contribute.

On first session start, `ensureGlobalConfig()` deploys the bundled defaults to
`~/.pi/patterns.yaml` if it doesn't already exist (idempotent).
The bundled defaults are embedded as a `DEFAULT_PATTERNS_YAML` template literal in
`config.ts` — this avoids the `dist/` compilation issue where `src/patterns.yaml`
is not copied by tsc.

```
~/.pi/patterns.yaml ────┐
.pi/patterns.yaml ──────┤
                        └──→ config.ts:loadConfig(cwd) ──→ getConfig()
                              (all found, merged together)
```

### Event flow

```
pi.on("tool_call") 3 handlers registered:
  1. Bash handler     → checkCommand() → pattern check → strict mode → normal
  2. Write/Edit handler → checkFileAccess() → path-based block
  3. Read handler       → checkFileAccess() → path-based block (zeroAccess only)

pi.on("session_start") → shows "Defender active" notification
pi.on("session_shutdown") → clears cached config
```

## Key concepts

### Patterns (src/patterns.yaml)

- **bashToolPatterns**: regex patterns with `reason` and optional `ask: true`
- **zeroAccessPaths**: no read/write/delete (secrets, keys)
- **readOnlyPaths**: read OK, write/edit blocked (system files, lockfiles)
- **noDeletePaths**: read/write/edit OK, delete blocked (project docs)

### Pattern matching (config.ts:checkCommand)

1. Tests `bashToolPatterns` regex against the bash command string
2. Checks if command references `zeroAccessPaths` (any operation)
3. Checks if command modifies `readOnlyPaths` (write/edit/delete patterns)
4. Checks if command deletes `noDeletePaths` (delete patterns only)

Returns `{ blocked, reason }`. Path-based checks return `{ blocked, reason }`.

### Bash handler tiers (index.ts)

```
1. patterns.yaml BLOCKED → patternBlockedPrompt() selector: ⚠️ Allow / ❌ Deny & Abort
   - Allow → returns undefined (command runs), skips remaining tiers
   - Deny → sets aborted=true, blocks everything until /defender:strict off

2. ABORTED STATE → blocks all bash with 🛡️❌ message

3. STRICT MODE → strictModePrompt() selector: ✅ Approve / ⚠️ Deny / 📋 Allow & Whitelist / ⭐ Approve All / ❌ Abort
   - approveAllSession flag auto-approves safe commands
   - Abort sets aborted=true and `ctx.abort()`

4. NORMAL MODE → existing ask/allow behavior
```

### Selector UI

Two custom UI prompts using `ctx.ui.custom()`:
- **patternBlockedPrompt**: 2 options, yellow/warning theme, shows pattern reason
- **strictModePrompt**: 4 options, accent theme, shows command preview

Both fall back to `ctx.ui.confirm()` if custom UI unavailable.

## Commands

| Command | Handler |
|---|---|
| `/defender:status` | Shows stats + strict mode state |
| `/defender:reload` | Clears cached config, reloads from YAML |
| `/defender:patterns` | Copies bundled YAML to `.pi/defender/patterns.yaml` |
| `/defender:strict [on\|off]` | Toggles strict mode, resets approveAll/aborted |

## When editing patterns

1. Edit `src/patterns.yaml` — bundled defaults shipped with the package
2. Run `/defender:reload` to apply changes in-session

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
