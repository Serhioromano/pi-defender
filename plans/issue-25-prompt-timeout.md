# Plan: Issue #25 — Timeout for Defender Prompts

**Issue:** [Timeout: auto-deny Defender prompts after configurable duration](https://github.com/Serhioromano/pi-defender/issues/25)

**Label:** enhancement | **Status:** plan

---

## Summary

Add two new config options: `promptTimeout` (seconds) and `autoApprove` (boolean).
These apply **only to the strict mode selector** (`strictModePrompt` — the
Approve / Whitelist / Approve All / Deny / Abort popup).

- **Pattern-blocked prompts (`patternBlockedPrompt`) are NOT affected** — those
  are security-critical blocks (`rm -rf`, `sudo`, secrets access) that must never
  auto-dismiss without explicit user action.
- **Strict Mode OFF** → no prompts at all, timeout is irrelevant.
- **Strict Mode ON** → the selector appears, and if the user doesn't respond
  within the timeout:
  - `autoApprove: false` (default) → auto-**deny**
  - `autoApprove: true` → auto-**approve**

A live countdown indicator is shown in the TUI while waiting.

### Config

```yaml
# Bundled defaults (src/patterns.yaml — shipped, overwritten on install):
promptTimeout: 120   # 2 minutes
autoApprove: false   # deny on timeout (secure by default)

# User overrides (defender.yaml — NEVER overwritten, higher priority):
promptTimeout: 30    # shorter timeout for this project
autoApprove: true    # or: auto-approve instead of deny
```

---

## Config Priority (for `promptTimeout` and `autoApprove`)

Loading order: `.pi/patterns.yaml` → `~/.pi/patterns.yaml` → `.pi/defender.yaml` → `~/.pi/defender.yaml`

**Last-wins semantics** — reverse scan, first non-undefined wins:

| Priority | Source | Role |
|---|---|---|
| 🥇 Highest | `.pi/defender.yaml` | Project user overrides |
| 🥈 | `~/.pi/defender.yaml` | Global user overrides |
| 🥉 | `~/.pi/patterns.yaml` | Shipped defaults (global) |
| 🥉 Lowest | `.pi/patterns.yaml` | Shipped defaults (local) |

User `defender.yaml` always beats shipped `patterns.yaml`. Project-local beats global.

> Differs from `defaultMode` which uses **first-wins** — both are after patterns.yaml
> in the loading order, so first-wins works naturally for `defaultMode`. For these
> new fields, patterns.yaml provides defaults that defender.yaml should override,
> so last-wins (reverse scan) is the correct merge strategy.

---

## Files to Modify

### 1. `src/patterns.yaml` — Bundled defaults

Add to the existing YAML:

```yaml
# Prompt timeout in seconds for strict mode selector. 0 = no timeout. 120 = 2 minutes (default).
promptTimeout: 120

# What to do when the timeout fires. false = deny (secure-by-default), true = auto-approve.
autoApprove: false
```

These ship with the package and are deployed to `.pi/patterns.yaml` and
`~/.pi/patterns.yaml` on install/postinstall. Users override in `defender.yaml`.

---

### 2. `src/config.ts` — Config type + loading

#### `Config` interface (~line 17)

Add:
```ts
/** Seconds before strict-mode prompt auto-dismisses. 0 or undefined = no timeout. */
promptTimeout?: number;
/** false = auto-deny on timeout (default), true = auto-approve. */
autoApprove?: boolean;
```

#### `parseConfigFile()` (~line 120)

Extract from parsed YAML:
```ts
promptTimeout: (raw.promptTimeout as number) || undefined,
autoApprove: (raw.autoApprove as boolean) ?? undefined,
```

#### `mergeConfigs()` (~line 135)

**Last-wins** for these two fields (reverse scan, first non-undefined wins):
```ts
// promptTimeout and autoApprove: last-wins so defender.yaml (user, never
// overwritten) overrides patterns.yaml (shipped, overwritten on install).
const configsReversed = [...configs].reverse();
const promptTimeout = configsReversed.find(c => c.promptTimeout !== undefined)?.promptTimeout;
const autoApprove = configsReversed.find(c => c.autoApprove !== undefined)?.autoApprove;
```

Then include in the returned merged config alongside `defaultMode`.

---

### 3. `src/index.ts` — Timeout in `strictModePrompt` only

#### 3a. Update function signature

```ts
async function strictModePrompt(
  ctx: any, command: string,
  stepInfo?: string,
  promptTimeout?: number,
  autoApprove?: boolean,
): Promise<"approve" | "deny" | "approve_all" | "abort" | "whitelist">
```

#### 3b. Update call site (in Bash handler, strict mode section)

```ts
const choice = await strictModePrompt(ctx, subCmd, stepInfo, config.promptTimeout, config.autoApprove);
```

#### 3c. Implement timeout inside `ctx.ui.custom()` callback

After `savedTheme = theme`:

```ts
let timeoutId: ReturnType<typeof setTimeout> | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
let remainingSeconds = promptTimeout && promptTimeout > 0 ? promptTimeout : 0;

if (remainingSeconds > 0) {
  const timeoutAction = autoApprove ? "approve" : "deny";

  intervalId = setInterval(() => {
    remainingSeconds--;
    if (remainingSeconds <= 0) {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
    }
    _tui.requestRender();
  }, 1000);

  timeoutId = setTimeout(() => {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    done(timeoutAction);
  }, promptTimeout! * 1000);
}
```

**`render()` — countdown in footer:**
```ts
const actionLabel = autoApprove ? "auto-approve" : "auto-deny";
const timerText = remainingSeconds > 0
  ? theme.fg("warning", ` ⏳ Will ${actionLabel} in ${remainingSeconds}s...`)
  : theme.fg("dim", " ↑↓ navigate · 1-N select · enter confirm · esc deny");
lines.push(timerText);
```

**`handleInput()` — cleanup before `done()`:**
```ts
// At the start of handleInput, before any done() call:
if (timeoutId) clearTimeout(timeoutId);
if (intervalId) clearInterval(intervalId);
```

**Return object — add `dispose`:**
```ts
return {
  render,
  invalidate: () => { /* existing no-op */ },
  dispose: () => {
    if (timeoutId) clearTimeout(timeoutId);
    if (intervalId) clearInterval(intervalId);
  },
  handleInput,
};
```

#### 3d. `patternBlockedPrompt` — NOT modified

The patterns-blocked selector (`rm -rf`, `sudo`, secrets access) remains
untimed — these are security-critical blocks that require explicit user action.

#### 3e. Fallback confirm dialog

`ctx.ui.confirm()` is a blocking API with no timeout support — `promptTimeout`
and `autoApprove` are ignored in this path.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| `promptTimeout: 0` or not set | No timeout, current behavior unchanged |
| `autoApprove: false` (default) | Timeout → `done("deny")`, command blocked |
| `autoApprove: true` | Timeout → `done("approve")`, command allowed |
| Strict Mode OFF | No prompts at all — timeout irrelevant |
| Pattern-blocked prompt | No timeout — must always require explicit user action |
| User presses a key during countdown | Timer continues — fixed countdown, not idle timer |
| Timer fires during chain sub-command | That sub-command denied/approved, next sub-command gets fresh timer |
| `ctx.ui.custom` unavailable | Falls back to `ctx.ui.confirm()` — no timeout possible |

---

## What NOT to touch

- **`patternBlockedPrompt`** — security-critical, no auto-dismiss
- **`showModeSelector`** — session-start selector, runs once per session
- **Docs** — will be updated after implementation (CHANGELOG.md, README.md, AGENTS.md)

---

## Implementation Order

1. `src/patterns.yaml` — add `promptTimeout: 120` + `autoApprove: false`
2. `src/config.ts` — type, parsing, last-wins merge
3. `src/index.ts` — `strictModePrompt` timeout logic
4. `src/index.ts` — update call site to pass both config values
5. Update CHANGELOG.md, README.md, AGENTS.md
