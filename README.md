# Pi Defender 🛡️

> Inspired by [disler/claude-code-damage-control](https://github.com/disler/claude-code-damage-control)!

Defense-in-depth protection for [Pi](https://github.com/badlogic/pi-mono) coding agent. Blocks dangerous commands and protects sensitive files — a Pi port of [claude-code-damage-control](https://github.com/disler/claude-code-damage-control). Previously published as `pi-damage-control`.

<img width="800" alt="Pi Defender" src="https://raw.githubusercontent.com/Serhioromano/pi-defender/refs/heads/master/images/pi-defender.png">

## Features

### 🔒 Bash Command Protection
Regex patterns to block dangerous commands before execution. Instead of auto-blocking, shows a selector:
- ⚠️ **Allow anyway** — run the dangerous command despite the warning
- ❌ **Deny & Abort** — stop the entire prompt, all future bash blocked until reset

| Category | Examples |
|----------|----------|
| Destructive file ops | `rm -rf`, `find -delete` |
| Privilege escalation | `sudo`, `su -` |
| Database destruction | `DROP TABLE`, `DELETE FROM x;` (no WHERE) |
| Git force ops | `git push --force`, `git reset --hard` |
| Network attacks | `curl \| bash`, `wget \| sh` |
| Disk destruction | `dd if=`, `mkfs.*` |
| Docker hazards | `docker rm -f`, `docker system prune` |
| Package unpublish | `npm unpublish` |
| Permission danger | `chmod 777`, `chown -R` |
| System shutdown | `reboot`, `shutdown`, `halt` |

### 🛡️ Path Protection (3 levels)

| Level | Read | Write/Edit | Delete | Use for |
|-------|------|------------|--------|---------|
| **zeroAccess** | ❌ | ❌ | ❌ | Secrets, keys, credentials |
| **readOnly** | ✅ | ❌ | ❌ | System files, lockfiles |
| **noDelete** | ✅ | ✅ | ❌ | Important project files |

### ⚠️ Ask Mode
For destructive-but-valid commands (`git push --force`, `git push --delete`, `npm unpublish`), instead of blocking outright, the extension shows a confirmation dialog. You decide.

### 🔒 Strict Mode
Block ALL bash tool execution and require explicit user approval for every command. Perfect when you want to review every action the agent takes.

- **Selector UI**: Arrow-key navigable selector with 4 options per command:
  - ✅ **Approve** — run this command once
  - ⚠️ **Deny (try something else)** — block this command, agent can try alternative approach
  - ⭐ **Approve All Session** — auto-approve all future safe commands (patterns.yaml blocked rules still enforced)
  - ❌ **Abort (stop all execution)** — block this command AND lock all future bash commands until reset
- **patterns.yaml always enforced**: Commands matching blocked patterns are never allowed, even with approve-all
- Toggle with `/defender:strict` (on|off, or no parameter to toggle)
- Shows 🛡️🔒 badge when active

### 🎯 Protection targets
- **Bash tool**: command patterns + path references in commands
- **Write tool**: path check against zeroAccess and readOnly
- **Edit tool**: path check against zeroAccess and readOnly
- **Read tool**: path check against zeroAccess

## Quick Start

### Option 1: Install as Pi package

```bash
pi install npm:pi-defender
```

### Option 2: Manual (project-local)

```bash
mkdir -p .pi/extensions
curl -o .pi/extensions/defender.ts https://raw.githubusercontent.com/Serhioromano/pi-defender/main/src/index.ts
# Also copy config.ts and place patterns.yaml in .pi/defender/
```

### Option 3: Global

```bash
mkdir -p ~/.pi/agent/extensions/pi-defender
cd ~/.pi/agent/extensions/pi-defender
curl -L -O https://raw.githubusercontent.com/Serhioromano/pi-defender/main/package.json
mkdir src
curl -o src/index.ts https://raw.githubusercontent.com/Serhioromano/pi-defender/main/src/index.ts
curl -o src/config.ts https://raw.githubusercontent.com/Serhioromano/pi-defender/main/src/config.ts
npm install
```

## Configuration

Defender loads configuration in this order:

1. **Project-local**: `.pi/defender/patterns.yaml` *(project root)*
2. **Global**: `~/.pi/defender/patterns.yaml` *(user home)*
3. **Bundled defaults**: `src/patterns.yaml` *(shipped with the extension)*

First match wins. If project config exists, global and bundled are ignored.

### Initialize project config

In your Pi session:

```
/defender:patterns
```

This copies the bundled `src/patterns.yaml` into `.pi/defender/patterns.yaml`. Edit it to customize.

### patterns.yaml structure

```yaml
bashToolPatterns:
  - pattern: '\brm\s+-[rRf]'        # Block completely
    reason: rm with recursive or force flags

  - pattern: '\bgit\s+push\s+.*--force'  # Ask for confirmation
    reason: git push --force
    ask: true

zeroAccessPaths:
  - ~/.ssh/
  - *.pem
  - .env.production.local

readOnlyPaths:
  - /etc/
  - *.lock
  - ~/.bashrc

noDeletePaths:
  - .pi/
  - LICENSE
  - README.md
```

**Path pattern support:**
- Literal paths: `~/.ssh/`, `/etc/`, `.pi/` — prefix matching
- Glob patterns: `*.pem`, `*.lock`, `*-credentials.json` — fnmatch against basename and full path

### Reload config

```
/defender:reload
```

### Check status

```
/defender:status
```

Shows: blocked/allowed/asked counts and active config summary.

## Strict Mode

Strict mode adds an extra layer of protection — **every** bash command must be explicitly approved.

### Activate

```
/defender:strict on
```

You'll see: 🛡️🔒 Strict Mode ACTIVATED — ALL bash commands now require your approval

### Workflow

When the agent tries to run a bash command, a selector appears:

```
────────────────────────────────────────────────
 🛡️🔒 Strict Mode — Bash Command

  ls -la /some/path

 ▶ ✅ Approve this command
   ⚠️ Deny (try something else)
   ⭐ Approve ALL session (skip future prompts for safe commands)
   ❌ Abort (stop all execution)

 ↑↓ navigate · enter select · esc deny
────────────────────────────────────────────────
```

### Approve All Session

Selecting ⭐ **Approve All Session** auto-approves future bash commands that are not blocked by `patterns.yaml`. Blocked patterns (like `rm -rf`, `sudo`, etc.) are **always** enforced.

### Abort

Selecting ❌ **Abort (stop all execution)** blocks the current command AND locks down all future bash commands. The agent cannot execute any more bash commands until you reset with:

```
/defender:strict off
```

This is useful when the agent is going in a wrong direction and you want to stop it completely.

### Deactivate

```
/defender:strict off
```

Or toggle without a parameter:

```
/defender:strict
```

### Status

`/defender:status` shows strict mode state and per-mode statistics:

```
🛡️ Defender Stats
  Allowed: 42 | Blocked: 3 | Asked: 2
  Strict mode: 🔒 ACTIVE (approve-all session)
  Strict: 15 approved | 2 blocked | 1 approve-all
  ...
```

## What Gets Blocked / Prompted

### Bash commands matching patterns.yaml:
- Instead of auto-blocking, shows a **selector**: ⚠️ Allow anyway / ❌ Deny & Abort
- Deny stops the entire prompt — all future bash blocked until `/defender:strict off`
- Patterns checked: `bashToolPatterns` regex matches, `zeroAccessPaths` references, `readOnlyPaths`/`noDeletePaths` operations

### Bash commands referencing paths:

### Edit/Write blocked:
- Any path matching `zeroAccessPaths`
- Any path matching `readOnlyPaths`

### Read blocked:
- Any path matching `zeroAccessPaths`

## Commands

| Command | Description |
|---------|-------------|
| `/defender:status` | Show statistics, strict mode status, and active config |
| `/defender:reload` | Reload YAML configuration |
| `/defender:patterns` | Initialize project-local patterns.yaml |
| `/defender:strict [on|off]` | Toggle strict mode (blocks all bash, user approval required) |

## Directory Structure

```
pi-defender/
├── package.json           # npm package + pi extension manifest
├── src/
│   ├── index.ts           # Extension entry point
│   ├── config.ts          # Config loading, pattern matching, path checking
│   └── patterns.yaml      # Single source of truth — bundled defaults
├── README.md
├── CHANGELOG.md
└── LICENSE
```

**Installed locations:**
```
~/.pi/defender/patterns.yaml     # Global config
.pi/defender/patterns.yaml       # Project config
```

## How It Works

Pi extensions subscribe to the `tool_call` event, which fires before any tool execution. The extension:

1. **Bash tool**: Parses the command string, checks against regex patterns and path references
2. **Write/Edit tools**: Extracts the file path, checks against zeroAccess/readOnly lists
3. **Read tool**: Extracts the file path, checks against zeroAccess list

Blocked tools return `{ block: true, reason: "..." }` which Pi displays to the user.

Ask-mode patterns show a confirmation dialog via `ctx.ui.confirm()`.

## Testing

After installing, try these prompts in Pi:

```
> Run: rm -rf /tmp/test
```
Should block (rm with force flag).

```
> Run: git push --force origin main
```
Should prompt for confirmation.

```
> Write a file to /etc/hosts
```
Should block (system path).

```
> Read ~/.ssh/id_rsa
```
Should block (zero-access).

## Development

```bash
# Clone
gh repo clone Serhioromano/pi-defender
cd pi-defender

# Install deps
npm install

# Test with Pi
pi -e src/index.ts
```

## License

MIT — see [LICENSE](LICENSE)

## Credits

Previously published as [pi-damage-control](https://github.com/Serhioromano/pi-damage-control). Inspired by and ported from [claude-code-damage-control](https://github.com/disler/claude-code-damage-control) by [disler](https://github.com/disler). Adapted for Pi's native TypeScript extension API.
