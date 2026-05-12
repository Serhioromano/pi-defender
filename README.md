# Pi Damage Control 🛡️

Defense-in-depth protection for [Pi](https://github.com/badlogic/pi-mono) coding agent. Blocks dangerous commands and protects sensitive files — a Pi port of [claude-code-damage-control](https://github.com/disler/claude-code-damage-control).

<img width="800" alt="Pi Damage Control" src="https://github.com/Serhioromano/pi-damage-control/raw/main/images/pi-damage-control.png">

## Features

### 🔒 Bash Command Protection
Regex patterns to block dangerous commands before execution:

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

### 🎯 Protection targets
- **Bash tool**: command patterns + path references in commands
- **Write tool**: path check against zeroAccess and readOnly
- **Edit tool**: path check against zeroAccess and readOnly
- **Read tool**: path check against zeroAccess

## Quick Start

### Option 1: Install as Pi package

```bash
pi install git:github.com/Serhioromano/pi-damage-control
```

### Option 2: Manual (project-local)

```bash
mkdir -p .pi/extensions
curl -o .pi/extensions/damage-control.ts https://raw.githubusercontent.com/Serhioromano/pi-damage-control/main/src/index.ts
# Also copy config.ts and place patterns.yaml in .pi/damage-control/
```

### Option 3: Global

```bash
mkdir -p ~/.pi/agent/extensions/pi-damage-control
cd ~/.pi/agent/extensions/pi-damage-control
curl -L -O https://raw.githubusercontent.com/Serhioromano/pi-damage-control/main/package.json
mkdir src
curl -o src/index.ts https://raw.githubusercontent.com/Serhioromano/pi-damage-control/main/src/index.ts
curl -o src/config.ts https://raw.githubusercontent.com/Serhioromano/pi-damage-control/main/src/config.ts
npm install
```

## Configuration

Damage Control loads configuration in this order:

1. **Project-local**: `.pi/damage-control/patterns.yaml` *(project root)*
2. **Global**: `~/.pi/damage-control/patterns.yaml` *(user home)*
3. **Built-in defaults**: hardcoded patterns *(fallback)*

First match wins. If project config exists, global config is ignored.

### Initialize project config

In your Pi session:

```
/damage-control:patterns
```

This creates `.pi/damage-control/patterns.yaml` with a starter template.

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
/damage-control:reload
```

### Check status

```
/damage-control:status
```

Shows: blocked/allowed/asked counts and active config summary.

## What Gets Blocked

### Bash commands blocked:
- Commands matching any `bashToolPatterns` regex
- Commands referencing `zeroAccessPaths` (any operation, including reads)
- Commands referencing `readOnlyPaths` with write/edit/delete patterns
- Commands referencing `noDeletePaths` with delete patterns

### Edit/Write blocked:
- Any path matching `zeroAccessPaths`
- Any path matching `readOnlyPaths`

### Read blocked:
- Any path matching `zeroAccessPaths`

## Commands

| Command | Description |
|---------|-------------|
| `/damage-control:status` | Show statistics and active config |
| `/damage-control:reload` | Reload YAML configuration |
| `/damage-control:patterns` | Initialize project-local patterns.yaml |

## Directory Structure

```
pi-damage-control/
├── package.json           # npm package + pi extension manifest
├── src/
│   ├── index.ts           # Extension entry point
│   ├── config.ts          # Config loading, pattern matching, path checking
│   └── patterns.yaml      # Bundled default patterns (reference)
├── README.md
└── LICENSE
```

**Installed locations:**
```
~/.pi/damage-control/patterns.yaml     # Global config
.pi/damage-control/patterns.yaml       # Project config
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
gh repo clone Serhioromano/pi-damage-control
cd pi-damage-control

# Install deps
npm install

# Test with Pi
pi -e src/index.ts
```

## License

MIT — see [LICENSE](LICENSE)

## Credits

Inspired by and ported from [claude-code-damage-control](https://github.com/disler/claude-code-damage-control) by [disler](https://github.com/disler). Adapted for Pi's native TypeScript extension API.
