# Pi Defender 🛡️

> [!WARNING]
> This extension is provided "as is", without warranty of any kind. The author assumes no liability for damages or data loss resulting from its use. Always maintain up-to-date backups.

Defense-in-depth protection for [Pi](https://github.com/badlogic/pi-mono) — intercepts dangerous bash commands and file operations before they execute. Ported from [claude-code-damage-control](https://github.com/disler/claude-code-damage-control).

<img width="800" alt="Pi Defender" src="https://raw.githubusercontent.com/Serhioromano/pi-defender/refs/heads/master/images/pi-defender.png">

## Install

```bash
pi install npm:pi-defender
```

That's it. Pi Defender activates on your next session with **Strict Mode ON** by default — every bash command requires your approval.

## Features

**🛡️ Three layers of protection:**

| Layer | What it does |
|-------|-------------|
| **Pattern blocking** | Dangerous commands (`rm -rf`, `sudo`, `curl \| bash`, `DROP TABLE`, `dd if=`, `chmod 777`, `git push --force`) are intercepted with an ⚠️ Allow / ❌ Deny selector |
| **Path protection** | Sensitive paths are guarded at 3 levels: `zeroAccess` (no read/write/delete — secrets, keys), `readOnly` (write/edit blocked — system files), `noDelete` (delete blocked — project docs) |
| **Strict Mode** 🔒 | Every bash command requires explicit approval via arrow-key selector. Whitelist trusted commands to auto-approve them across sessions |

**TUI selector with keyboard shortcuts** — press `1`-`N` to instantly choose: Approve, Deny, Whitelist, Approve All, or Abort.

**Chained commands** — `cmd1 && cmd2 || cmd3` are split and each sub-command approved individually. Deny/Abort on any sub-command blocks the entire chain.

**Abort protection** — selecting ❌ Abort calls `ctx.abort()` to cancel the agent's turn and locks all future bash + file writes until you run `/defender:strict off`.

## Commands

| Command | Description |
|---------|-------------|
| `/defender:status` | Show stats, strict mode state, and config table |
| `/defender:reload` | Reload YAML config after editing |
| `/defender:patterns` | Initialize `.pi/patterns.yaml` with bundled defaults |
| `/defender:strict [on\|off]` | Toggle strict mode (ON by default) |
| `/defender:globalize-whitelist` | Copy unique local whitelist patterns to `~/.pi/defender.yaml` |
| `/defender:report-issue <desc>` | AI-enhanced bug/feature report → GitHub issue |

## Configuration

Pi Defender merges rules from up to 4 YAML files:

| File | Overwritten on update? | Purpose |
|------|----------------------|---------|
| `.pi/patterns.yaml` | ✅ Yes | Bundled security rules (shipped) |
| `~/.pi/patterns.yaml` | ✅ Yes | Bundled security rules (global) |
| `.pi/defender.yaml` | ❌ Never | Your custom patterns + whitelist |
| `~/.pi/defender.yaml` | ❌ Never | Your custom patterns + whitelist (global) |

All 4 are merged — no file overrides another. On session start, a config table shows what each file contributed.

### Adding patterns

Your custom rules go in `.pi/defender.yaml` (never overwritten on updates):

```yaml
# Block a custom command
bashToolPatterns:
  - pattern: '\bdangerous-tool\b'
    reason: Internal tool — never run via agent

# Add paths to protect
zeroAccessPaths:
  - .env.production
  - *.pem

# Trusted commands (skip strict mode prompts)
strictModeWhiteList:
  - ^npm\s+test\b
  - ^npm\s+run\sbuild\b
  - ^git\s+status\b
```

### Whitelist from strict mode

When strict mode prompts for a command you trust (e.g. `npm test`), select 📋 **Whitelist** to save it permanently. The pattern is written to `.pi/defender.yaml` under `strictModeWhiteList` — future runs auto-approve.

## Quick Commands to Try

After install, test protection in a Pi session:

```
# Should block (rm with force flag)
> Run: rm -rf /tmp/test

# Should prompt for confirmation
> Run: git push --force origin main

# Should block (system path)
> Write a file to /etc/hosts

# Should block (zero-access)
> Read ~/.ssh/id_rsa
```

## License

MIT — see [LICENSE](LICENSE)

## Credits

Previously published as [pi-damage-control](https://github.com/Serhioromano/pi-damage-control). Inspired by [claude-code-damage-control](https://github.com/disler/claude-code-damage-control) by [disler](https://github.com/disler).
