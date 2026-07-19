# Plan: Issue #24 — Auto-reject option for bashToolPatterns

**Issue:** [Feature Request: Auto-reject flag for bash commands and prompt timeout](https://github.com/Serhioromano/pi-defender/issues/24)

**Label:** enhancement | **Status:** plan

---

## Summary

Add an `autoReject: true` optional field to individual `bashToolPatterns` entries.
All bundled patterns ship with `autoReject: true`. The existing `promptTimeout`
config controls the countdown before auto-deny.

### Behavior matrix

`autoReject` only matters when there's NO timeout. When `promptTimeout > 0`,
the full prompt with all options is always shown — the timeout provides a default
action, but the user has full control to override it.

| `autoReject` | `promptTimeout` | Prompt | Options | Timeout action |
|---|---|---|---|---|
| `true` | > 0 | Full prompt + countdown | Allow anyway / Deny & Abort | Auto-**deny** (no abort) |
| `true` | 0 / not set | None (notification only) | N/A | Immediate **deny** |
| `false` | > 0 | Full prompt + countdown | Allow anyway / Deny & Abort | Auto-**deny** (no abort) |
| `false` | 0 / not set | Full prompt (current behavior) | Allow anyway / Deny & Abort | Wait forever |

Key: **timeout always auto-denies, never aborts**. The agent can try a safer
approach. Only explicit user selection of "Deny & Abort" aborts the session.

---

## Design decisions

1. **`autoReject: true` on ALL bundled patterns** — shipped `patterns.yaml` gets
   `autoReject: true` on every `bashToolPatterns` entry. Combined with default
   `promptTimeout: 120`, every dangerous command shows a 2-minute countdown prompt
   with full control — then auto-denies if no response. Users who want interactive
   prompts without a timer set `promptTimeout: 0` in `defender.yaml`. Users who
   want specific patterns to wait forever override with `autoReject: false`.

2. **Full prompt always shown when timeout is set** — the countdown prompt includes
   BOTH "⚠️ Allow anyway" and "❌ Deny & Abort". The timer is just a default —
   the user has full control during the countdown and can pick either option.

3. **`promptTimeout` now gates `patternBlockedPrompt` too** — previously
   `promptTimeout` only applied to `strictModePrompt`. Now when set (> 0),
   `patternBlockedPrompt` also gets a countdown with auto-deny on timeout.

4. **Timeout denies, does NOT abort** — timeout fires → `done("deny")`. The
   handler blocks just this command, `aborted` flag stays false. Only explicit
   user selection of "Deny & Abort" → `done("abort")` → handler sets `aborted`
   and calls `ctx.abort()`.

5. **No new YAML group** — `autoReject` is a field on existing `bashToolPatterns`
   entries. One glance tells you if a pattern is auto-reject or interactive.

6. **Tier 1 priority** — `checkCommand()` runs before strict mode, so auto-reject
   blocks regardless of strict mode state.

---

## Files to Modify

### 1. `src/patterns.yaml` — Add `autoReject: true` to every pattern

```yaml
bashToolPatterns:
  - pattern: '\brm\s+-[rRf]'
    autoReject: true
    reason: rm with recursive or force flags
  - pattern: '\bsudo\b'
    autoReject: true
    reason: sudo command execution
  # ... all 19 patterns get autoReject: true
```

---

### 2. `src/config.ts` — Types + `checkCommand()`

#### 2a. `BashPattern` interface

```typescript
export interface BashPattern {
  pattern: string;
  reason: string;
  /** When true and no promptTimeout: block immediately without prompt. */
  autoReject?: boolean;
}
```

#### 2b. `CheckResult` interface

```typescript
export interface CheckResult {
  blocked: boolean;
  reason: string;
  /** When true: if no promptTimeout, skip prompt and block immediately. */
  autoReject?: boolean;
}
```

#### 2c. `checkCommand()` — propagate `autoReject`

Destructure `autoReject` alongside `pattern` and `reason`, propagate in result:

```typescript
for (const { pattern, reason, autoReject } of config.bashToolPatterns) {
  try {
    const regex = new RegExp(pattern, "i");
    if (regex.test(matchTarget)) {
      return {
        blocked: true,
        reason: `Blocked: ${reason}`,
        autoReject: autoReject === true,
      };
    }
  } catch { continue; }
}
```

#### 2d. `parseConfigFile()` — No changes needed

YAML parser naturally includes `autoReject` boolean from each pattern entry.

---

### 3. `src/index.ts` — Bash handler + `patternBlockedPrompt`

#### 3a. `patternBlockedPrompt` — new signature

```typescript
async function patternBlockedPrompt(
  ctx: any,
  command: string,
  reason: string,
  stepInfo?: string,
  autoReject?: boolean,
  promptTimeout?: number,
): Promise<"allow" | "deny" | "abort">
```

Returns `"abort"` when user explicitly selects "Deny & Abort". Returns `"deny"`
for timeout, autoReject skip, and escape key. Returns `"allow"` when user permits.

#### 3b. Fast path — `autoReject: true` + no timeout

At the top of the function, before any UI:

```typescript
// autoReject with no timeout: skip prompt entirely, block immediately
if (autoReject && (!promptTimeout || promptTimeout <= 0)) {
  return "deny";
}
```

#### 3c. Full prompt with countdown — when timeout is set

Inside `ctx.ui.custom()`, same timeout logic as `strictModePrompt`:

```typescript
let timeoutId: ReturnType<typeof setTimeout> | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
let remainingSeconds = promptTimeout && promptTimeout > 0 ? promptTimeout : 0;

if (remainingSeconds > 0) {
  intervalId = setInterval(() => {
    remainingSeconds--;
    if (remainingSeconds <= 0 && intervalId) { clearInterval(intervalId); intervalId = null; }
    _tui.requestRender();
  }, 1000);
  timeoutId = setTimeout(() => {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    done("deny");  // auto-deny, NOT abort
  }, promptTimeout! * 1000);
}
```

Options always include both (no "simplified" variant):

```typescript
const options = [
  { value: "allow", label: "⚠️ Allow anyway (dangerous)" },
  { value: "abort", label: "❌ Deny & Abort (stop entire prompt)" },
];
```

Footer:
```typescript
const timerText = remainingSeconds > 0
  ? theme.fg("warning", ` ⏳ Will auto-deny in ${remainingSeconds}s...`)
  : theme.fg("dim", " ↑↓ navigate · 1-2 select · enter confirm · esc deny");
```

`handleInput` clears timers on any keypress before processing the input.
Number keys: `1` → `done("allow")`, `2` → `done("abort")`.
Escape → `done("deny")`.
`dispose` callback clears both timers.

#### 3d. No timeout → current behavior

When `promptTimeout` is 0/undefined and `autoReject` is false/undefined:
exact current behavior (no timer, wait forever, "Allow anyway" + "Deny & Abort").
The "Deny & Abort" option returns `"abort"` instead of `"deny"` (minor change
to match the new 3-value return type).

#### 3e. Bash handler — Tier 1 rework

```typescript
const result = checkCommand(subCmd, config);

if (result.blocked) {
  stats.blocked++;

  if (!ctx.hasUI) {
    ctx.ui.notify(`🛡️ BLOCKED by patterns.yaml: ${result.reason}`, "error");
    return { block: true, reason: `Blocked by patterns.yaml: ${result.reason}` };
  }

  const choice = await patternBlockedPrompt(
    ctx, subCmd, result.reason, stepInfo,
    result.autoReject, config.promptTimeout,
  );

  if (choice === "abort") {
    aborted = true;
    stats.strictBlocked++;
    ctx.ui.notify(
      `🛡️❌ Denied & Aborted — patterns.yaml: ${result.reason}. Use /defender:strict off to reset.`,
      "error",
    );
    ctx.abort?.();
    return { block: true, reason: `Denied by user (patterns.yaml: ${result.reason}) — execution aborted` };
  }

  if (choice === "deny") {
    stats.strictBlocked++;
    ctx.ui.notify(
      `🛡️ Denied by patterns.yaml: ${result.reason}`,
      "warning",
    );
    return { block: true, reason: `Blocked by patterns.yaml: ${result.reason}` };
  }

  // choice === "allow" — user overrode, skip strict mode, continue
  ctx.ui.notify(
    `⚠️ Allowed by user (patterns.yaml: ${result.reason}) — ${subCmd.length > 60 ? subCmd.slice(0, 57) + "..." : subCmd}`,
    "warning",
  );
  stats.allowed++;
  continue;
}
```

---

### 4. Prompt rendering — always the same 2 options

The `patternBlockedPrompt` custom UI ALWAYS shows:

```
🛡️ BLOCKED by patterns.yaml
  Command: sudo rm -rf /tmp/test
  Reason: sudo command execution

 ▶ [1] ⚠️ Allow anyway (dangerous)
   [2] ❌ Deny & Abort (stop entire prompt)

 ⏳ Will auto-deny in 87s...
```

When no timeout: footer shows `↑↓ navigate · 1-2 select · enter confirm · esc deny`
and no timer runs.

When `autoReject: true` + no timeout: no UI at all, just a notification.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| `autoReject: true` + `promptTimeout: 120` | Full prompt with countdown, both options. Timeout → deny (no abort) |
| `autoReject: true` + `promptTimeout: 0` | Immediate deny, notification only |
| `autoReject: false` + `promptTimeout: 120` | Full prompt with countdown, both options. Timeout → deny (no abort) |
| `autoReject: false` + `promptTimeout: 0` | Current behavior — wait forever |
| User selects "Deny & Abort" | Returns `"abort"` → handler sets `aborted = true`, calls `ctx.abort()` |
| User selects "Allow anyway" | Returns `"allow"` → command runs, skips strict mode |
| Timeout fires | Returns `"deny"` → handler blocks command, `aborted` stays false |
| Headless (no UI) | Always blocked with notification (no prompt possible) |
| Chained command, one sub-command matches | That sub-command processed, full chain denied if blocked |
| `autoReject: true` + strict mode ON | Tier 1 blocks before strict mode — strict mode unreachable |
| `autoReject: true` + defenderDisabled | `defenderDisabled` skips ALL tool_call analysis — autoReject irrelevant |

---

## What NOT to touch

- **`strictModePrompt()`** — unchanged (timeout already implemented in #25)
- **`showModeSelector()`** — unchanged
- **`checkWhitelist()`** — auto-reject runs before whitelist check
- **`defaultMode` / `autoApprove`** — separate features
- **File protection handlers (Write/Edit/Read)** — autoReject applies only to bash
- **`checkSessionApproved()`** — unchanged (auto-reject has higher priority)

---

## Implementation Order

1. `src/patterns.yaml` — add `autoReject: true` to every `bashToolPatterns` entry
2. `src/config.ts` — `BashPattern.autoReject?: boolean` + `CheckResult.autoReject?: boolean`
3. `src/config.ts` — `checkCommand()` propagate `autoReject` in result
4. `src/index.ts` — `patternBlockedPrompt`: new signature, autoReject fast path, timeout countdown, "abort" return value
5. `src/index.ts` — Bash handler tier 1: pass `autoReject` + `promptTimeout`, handle `"abort"` vs `"deny"`
6. Update CHANGELOG.md, README.md, AGENTS.md

---

## Verification

1. Check all bundled patterns have `autoReject: true` in `patterns.yaml`
2. `/defender:reload` — verify config shows patterns loaded
3. `sudo ls` → full prompt with countdown, both options, auto-denies after 120s
4. Select "Deny & Abort" → session aborted, all commands blocked until `/defender:strict off`
5. Select "Allow anyway" → command runs
6. Set `promptTimeout: 0` in `defender.yaml`, `/defender:reload` → `sudo ls` immediately blocked with notification
7. Override one pattern with `autoReject: false` in `defender.yaml`, `promptTimeout: 0` → wait forever (current behavior)
8. Verify timeout deny does NOT abort — agent can try another command
