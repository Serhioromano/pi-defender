/**
 * Pi Defender
 * ==========
 *
 * Defense-in-depth protection for Pi coding agent.
 * Blocks dangerous commands and protects sensitive files via Pi extensions.
 *
 * Features:
 *   - Bash tool: regex patterns to block dangerous commands (rm -rf, sudo, etc.)
 *   - Bash tool: ask mode for destructive-but-valid commands (git push --force)
 *   - Edit/Write/Read tools: path-level protection (zero-access, read-only)
 *   - Bash tool: path reference detection in commands
 *   - Strict mode: block ALL bash commands, require user approval per command
 *   - Approve-all session: auto-approve safe commands in strict mode
 *   - Interactive selector UI with approve/deny/approve-all options
 *   - YAML configuration (project-local or global)
 *   - Management commands: /defender:reload, /defender:status, /defender:patterns, /defender:strict
 *
 * Previously: pi-damage-control
 * Inspired by: https://github.com/disler/claude-code-damage-control
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { loadConfig, checkCommand, checkFileAccess, type Config } from "./config";

// =============================================================================
// DEFAULT PATTERNS (bundled, used when no YAML config found)
// =============================================================================

const DEFAULT_BASH_PATTERNS = [
  { pattern: "\\brm\\s+-[rRf]", reason: "rm with recursive or force flags" },
  { pattern: "\\bfind\\s+.*\\s+-delete\\b", reason: "find with -delete" },
  { pattern: "\\bsudo\\b", reason: "sudo command execution" },
  { pattern: "\\bDROP\\s+(TABLE|DATABASE|SCHEMA)\\b", reason: "SQL DROP statement" },
  { pattern: "\\bDELETE\\s+FROM\\s+\\w+\\s*;", reason: "DELETE without WHERE clause" },
  { pattern: "\\bTRUNCATE\\s+(TABLE\\s+)?\\w+", reason: "SQL TRUNCATE" },
  { pattern: "\\bgit\\s+push\\s+.*--force", reason: "git push --force", ask: true },
  { pattern: "\\bgit\\s+push\\s+.*--delete\\b", reason: "git push --delete", ask: true },
  { pattern: "\\bgit\\s+reset\\s+--hard\\b", reason: "git reset --hard" },
  { pattern: "\\bgit\\s+clean\\s+-[fd]+", reason: "git clean" },
  { pattern: "\\bcurl\\s+.*\\|\\s*(ba)?sh", reason: "curl piped to bash" },
  { pattern: "\\bwget\\s+.*\\|\\s*(ba)?sh", reason: "wget piped to bash" },
  { pattern: "\\bdd\\s+if=", reason: "dd disk operations" },
  { pattern: "\\bmkfs\\.\\w+", reason: "filesystem formatting" },
  { pattern: "\\bdocker\\s+rm\\s+-f\\b", reason: "docker forced container removal" },
  { pattern: "\\bnpm\\s+unpublish\\b", reason: "npm unpublish", ask: true },
  { pattern: "\\bchmod\\s+.*777", reason: "chmod 777 (world-writable)" },
  { pattern: "\\bchown\\s+-R\\b", reason: "recursive chown" },
  { pattern: ":\\(\\)\\s*\\{", reason: "fork bomb pattern" },
  { pattern: "\\b(shutdown|reboot|halt|poweroff)\\b", reason: "system shutdown/reboot" },
];

const DEFAULT_ZERO_ACCESS = [
  "~/.ssh/", "~/.aws/", "*.pem", "*.key", "id_rsa", "id_ed25519",
  ".env.production.local", "*-credentials.json", "*-secrets.yaml",
];

const DEFAULT_READ_ONLY = [
  "/etc/", "~/.bashrc", "~/.zshrc", "~/.profile",
  "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
];

const DEFAULT_NO_DELETE = [
  ".pi/", "LICENSE", "README.md", "CHANGELOG.md",
];

function getDefaultConfig(): Config {
  return {
    bashToolPatterns: DEFAULT_BASH_PATTERNS,
    zeroAccessPaths: DEFAULT_ZERO_ACCESS,
    readOnlyPaths: DEFAULT_READ_ONLY,
    noDeletePaths: DEFAULT_NO_DELETE,
  };
}

// =============================================================================
// EXTENSION
// =============================================================================

export default function (pi: ExtensionAPI) {
  let currentConfig: Config | null = null;
  let stats = { blocked: 0, asked: 0, allowed: 0, strictBlocked: 0, strictApproved: 0, strictApprovedAll: 0 };
  let strictMode = false;
  let approveAllSession = false;
  let aborted = false;

  function getConfig(cwd: string): Config {
    if (currentConfig) return currentConfig;
    const loaded = loadConfig(cwd);
    // Merge with defaults: user config takes precedence, defaults fill gaps
    currentConfig = {
      bashToolPatterns: loaded.bashToolPatterns.length > 0 ? loaded.bashToolPatterns : getDefaultConfig().bashToolPatterns,
      zeroAccessPaths: loaded.zeroAccessPaths.length > 0 ? loaded.zeroAccessPaths : getDefaultConfig().zeroAccessPaths,
      readOnlyPaths: loaded.readOnlyPaths.length > 0 ? loaded.readOnlyPaths : getDefaultConfig().readOnlyPaths,
      noDeletePaths: loaded.noDeletePaths.length > 0 ? loaded.noDeletePaths : getDefaultConfig().noDeletePaths,
    };
    return currentConfig;
  }

  // ===========================================================================
  // SESSION START
  // ===========================================================================

  pi.on("session_start", async (_event, ctx) => {
    const config = getConfig(ctx.cwd);
    ctx.ui.notify(
      `🛡️ Defender active (${config.bashToolPatterns.length} patterns, ${config.zeroAccessPaths.length} zero-access, ${config.readOnlyPaths.length} read-only)`,
      "info",
    );
  });

  // ===========================================================================
  // STRICT MODE SELECTOR
  // ===========================================================================

  async function strictModePrompt(ctx: any, command: string): Promise<"approve" | "deny" | "approve_all" | "abort"> {
    const displayCmd = command.length > 80 ? command.slice(0, 77) + "..." : command;

    // Try custom UI selector first
    if (typeof ctx.ui?.custom === "function") {
      try {
        const result = await ctx.ui.custom<string>(
          (_tui: any, theme: any, _kb: any, done: (value: string) => void) => {
            let selectedIndex = 0;
            const options = [
              { value: "approve", label: "✅ Approve this command" },
              { value: "deny", label: "⚠️ Deny (try something else)" },
              { value: "approve_all", label: "⭐ Approve ALL session (skip future prompts for safe commands)" },
              { value: "abort", label: "❌ Abort (stop all execution)" },
            ];

            function render(width: number): string[] {
              const lines: string[] = [];
              const sep = "─".repeat(Math.min(width, 80));
              lines.push(theme.fg("accent", sep));
              lines.push(theme.fg("accent", theme.bold(" 🛡️🔒 Strict Mode — Bash Command")));
              lines.push("");
              lines.push(theme.fg("dim", `  ${displayCmd}`));
              lines.push("");
              for (let i = 0; i < options.length; i++) {
                const isSelected = i === selectedIndex;
                const prefix = isSelected ? theme.fg("accent", "▶") : " ";
                const label = isSelected
                  ? theme.fg("accent", options[i].label)
                  : options[i].label;
                lines.push(` ${prefix} ${label}`);
              }
              lines.push("");
              lines.push(theme.fg("dim", " ↑↓ navigate · enter select · esc deny"));
              lines.push(theme.fg("accent", sep));
              return lines;
            }

            return {
              render,
              invalidate: () => {},
              handleInput: (data: string) => {
                if (data === "\x1b[A" || data === "k") {
                  selectedIndex = (selectedIndex - 1 + options.length) % options.length;
                  _tui.requestRender();
                } else if (data === "\x1b[B" || data === "j") {
                  selectedIndex = (selectedIndex + 1) % options.length;
                  _tui.requestRender();
                } else if (data === "\r" || data === "\n") {
                  done(options[selectedIndex].value);
                } else if (data === "\x1b") {
                  done("deny");
                }
              },
            };
          },
        );
        return (result ?? "deny") as "approve" | "deny" | "approve_all" | "abort";
      } catch {
        // Fall through to confirm fallback
      }
    }

    // Fallback: two-step confirm dialog
    if (typeof ctx.ui?.confirm === "function") {
      const choice = await ctx.ui.confirm(
        "🛡️🔒 Strict Mode — Bash Command",
        `${displayCmd}\n\nAllow this command?\n\n(No = deny, Esc = abort via /defender:strict off)`,
      );
      if (!choice) return "deny";

      const approveAll = await ctx.ui.confirm(
        "🛡️ Strict Mode",
        "Approve ALL future bash commands this session? (patterns.yaml blocked rules still apply)",
      );
      return approveAll ? "approve_all" : "approve";
    }

    // No UI available — block by default
    return "deny";
  }

  // ===========================================================================
  // TOOL CALL INTERCEPTION — Bash
  // ===========================================================================

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    if (!command) return undefined;

    const config = getConfig(ctx.cwd);
    const result = checkCommand(command, config);

    // 1. PATTERNS.YAML BLOCKED — always enforced (even in strict mode)
    if (result.blocked) {
      stats.blocked++;
      ctx.ui.notify(`🛡️ BLOCKED: ${result.reason}`, "error");
      return { block: true, reason: result.reason };
    }

    // 2. ABORTED STATE — block all bash after user aborted
    if (aborted) {
      stats.strictBlocked++;
      ctx.ui.notify(
        `🛡️❌ Execution ABORTED by user — all bash commands blocked. Use /defender:strict off to reset.`,
        "error",
      );
      return { block: true, reason: "Execution aborted by user — use /defender:strict off to reset" };
    }

    // 3. STRICT MODE — block all bash unless approved
    if (strictMode) {
      // approveAllSession auto-approves commands not blocked by patterns.yaml
      if (approveAllSession) {
        stats.strictApproved++;
        ctx.ui.notify(
          `🛡️🔒 Strict Mode: auto-approved (approve-all active) — ${command.length > 60 ? command.slice(0, 57) + "..." : command}`,
          "info",
        );
        return undefined;
      }

      // No UI — block
      if (!ctx.hasUI) {
        stats.strictBlocked++;
        ctx.ui.notify(`🛡️🔒 Strict Mode: blocked (no UI) — use /defender:strict off to disable`, "error");
        return { block: true, reason: "Strict mode active — all bash commands require approval (no UI available)" };
      }

      // Show selector
      const choice = await strictModePrompt(ctx, command);

      if (choice === "deny") {
        stats.strictBlocked++;
        ctx.ui.notify(`🛡️🔒 Strict Mode: denied — try something else`, "warning");
        return { block: true, reason: "Blocked by user in strict mode — try a different approach" };
      }

      if (choice === "abort") {
        aborted = true;
        stats.strictBlocked++;
        ctx.ui.notify(
          `🛡️❌ Execution ABORTED by user — all bash commands now blocked. Use /defender:strict off to reset.`,
          "error",
        );
        return { block: true, reason: "Execution aborted by user — use /defender:strict off to reset" };
      }

      if (choice === "approve_all") {
        approveAllSession = true;
        stats.strictApprovedAll++;
        ctx.ui.notify(
          `🛡️🔒 Strict Mode: ⭐ Approve All Session activated — future bash commands auto-approved (patterns.yaml rules still enforced)`,
          "info",
        );
      } else {
        stats.strictApproved++;
      }

      ctx.ui.notify(
        `🛡️🔒 Strict Mode: approved — ${command.length > 60 ? command.slice(0, 57) + "..." : command}`,
        "info",
      );
      return undefined;
    }

    // 4. NORMAL MODE — existing behavior
    if (result.ask) {
      stats.asked++;
      if (!ctx.hasUI) {
        stats.blocked++;
        ctx.ui.notify(`🛡️ BLOCKED: ${result.reason} (no UI for confirmation)`, "error");
        return { block: true, reason: `Blocked (no UI): ${result.reason}` };
      }

      const displayCmd = command.length > 200 ? command.slice(0, 200) + "..." : command;
      const allowed = await ctx.ui.confirm(
        "⚠️ Dangerous Command",
        `Reason: ${result.reason}\n\nCommand: ${displayCmd}\n\nAllow this command?`,
      );

      if (!allowed) {
        stats.blocked++;
        ctx.ui.notify(`🛡️ BLOCKED by user: ${result.reason}`, "warning");
        return { block: true, reason: `Blocked by user: ${result.reason}` };
      }

      stats.allowed++;
      ctx.ui.notify(`⚠️ Allowed by user: ${result.reason}`, "warning");
    } else {
      stats.allowed++;
    }

    return undefined;
  });

  // ===========================================================================
  // TOOL CALL INTERCEPTION — Write / Edit
  // ===========================================================================

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const path = event.input.path as string;
    if (!path) return undefined;

    const config = getConfig(ctx.cwd);
    const operation = event.toolName === "write" ? "write" : "edit";
    const check = checkFileAccess(path, config, operation);

    if (check.blocked) {
      stats.blocked++;
      ctx.ui.notify(`🛡️ BLOCKED: ${check.reason}`, "error");
      return { block: true, reason: check.reason };
    }

    stats.allowed++;
    return undefined;
  });

  // ===========================================================================
  // TOOL CALL INTERCEPTION — Read
  // ===========================================================================

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("read", event)) return undefined;

    const path = event.input.path;
    if (!path) return undefined;

    const config = getConfig(ctx.cwd);
    const check = checkFileAccess(path, config, "read");

    if (check.blocked) {
      stats.blocked++;
      ctx.ui.notify(`🛡️ BLOCKED: ${check.reason}`, "error");
      return { block: true, reason: check.reason };
    }

    stats.allowed++;
    return undefined;
  });

  // ===========================================================================
  // COMMANDS
  // ===========================================================================

  pi.registerCommand("defender:status", {
    description: "Show defender statistics and active configuration",
    handler: async (_args, ctx) => {
      const config = getConfig(ctx.cwd);
      const abortStatus = aborted ? " ❌ ABORTED" : "";
      const strictStatus = strictMode
        ? `🔒 ACTIVE${approveAllSession ? " (approve-all session)" : ""}${abortStatus}`
        : aborted
          ? `❌ ABORTED (use /defender:strict off to reset)`
          : "⚪ OFF";
      ctx.ui.notify(
        `🛡️ Defender Stats\n` +
        `  Allowed: ${stats.allowed} | Blocked: ${stats.blocked} | Asked: ${stats.asked}\n` +
        `  Strict mode: ${strictStatus}\n` +
        `  Strict: ${stats.strictApproved} approved | ${stats.strictBlocked} blocked | ${stats.strictApprovedAll} approve-all\n` +
        `  Bash patterns: ${config.bashToolPatterns.length}\n` +
        `  Zero-access paths: ${config.zeroAccessPaths.length}\n` +
        `  Read-only paths: ${config.readOnlyPaths.length}\n` +
        `  No-delete paths: ${config.noDeletePaths.length}`,
        "info",
      );
    },
  });

  pi.registerCommand("defender:reload", {
    description: "Reload defender configuration from YAML",
    handler: async (_args, ctx) => {
      currentConfig = null;
      const config = getConfig(ctx.cwd);
      ctx.ui.notify(
        `🛡️ Config reloaded: ${config.bashToolPatterns.length} patterns, ${config.zeroAccessPaths.length} zero-access, ${config.readOnlyPaths.length} read-only`,
        "info",
      );
    },
  });

  pi.registerCommand("defender:patterns", {
    description: "Initialize project-local patterns.yaml from template",
    handler: async (_args, ctx) => {
      const dir = join(ctx.cwd, ".pi", "defender");
      const file = join(dir, "patterns.yaml");

      if (existsSync(file)) {
        ctx.ui.notify(`patterns.yaml already exists at ${file}`, "warning");
        return;
      }

      mkdirSync(dir, { recursive: true });
      writeFileSync(file, PATTERNS_YAML_TEMPLATE, "utf-8");
      ctx.ui.notify(`✅ Created ${file} — edit it to customize protection rules, then /defender:reload`, "info");
    },
  });

  pi.registerCommand("defender:strict", {
    description: "Toggle strict mode — blocks ALL bash commands requiring user approval (on|off, or toggle)",
    handler: async (args, ctx) => {
      const mode = args.toLowerCase().trim();

      if (mode === "on") {
        if (strictMode) {
          ctx.ui.notify("🛡️🔒 Strict Mode is already ACTIVE", "warning");
        } else {
          strictMode = true;
          approveAllSession = false;
          aborted = false;
          ctx.ui.notify(
            "🛡️🔒 Strict Mode ACTIVATED — ALL bash commands now require your approval\n" +
            "   • Select ✅ Approve / ⚠️ Deny / ⭐ Approve All / ❌ Abort\n" +
            "   • patterns.yaml blocked rules are ALWAYS enforced\n" +
            "   • /defender:strict off to disable",
            "info",
          );
        }
      } else if (mode === "off") {
        if (!strictMode && !aborted) {
          ctx.ui.notify("🛡️ Strict Mode is already OFF", "warning");
        } else {
          strictMode = false;
          approveAllSession = false;
          aborted = false;
          ctx.ui.notify(
            "🛡️ Strict Mode DEACTIVATED — normal protection restored (patterns.yaml rules only)",
            "info",
          );
        }
      } else {
        // Toggle
        if (strictMode || aborted) {
          // Turning OFF
          strictMode = false;
          approveAllSession = false;
          aborted = false;
          ctx.ui.notify(
            "🛡️ Strict Mode DEACTIVATED — normal protection restored (patterns.yaml rules only)",
            "info",
          );
        } else {
          // Turning ON
          strictMode = true;
          approveAllSession = false;
          aborted = false;
          ctx.ui.notify(
            "🛡️🔒 Strict Mode ACTIVATED — ALL bash commands now require your approval\n" +
            "   • Select ✅ Approve / ⚠️ Deny / ⭐ Approve All / ❌ Abort\n" +
            "   • patterns.yaml blocked rules are ALWAYS enforced\n" +
            "   • /defender:strict off to disable",
            "info",
          );
        }
      }
    },
  });

  // ===========================================================================
  // SESSION SHUTDOWN
  // ===========================================================================

  pi.on("session_shutdown", async () => {
    currentConfig = null;
  });
}

// =============================================================================
// PATTERNS YAML TEMPLATE
// =============================================================================

const PATTERNS_YAML_TEMPLATE = `# Pi Defender — Security Patterns
# =============================================================
# Edit this file to customize which operations are blocked.
#
# bashToolPatterns: regex patterns matched against Bash commands
#   - pattern: JS regex (case-insensitive)
#   - reason: explanation shown when blocked
#   - ask: true → prompt for confirmation instead of blocking
#
# zeroAccessPaths: no read/write/delete allowed (secrets)
# readOnlyPaths:   read allowed, write/edit/delete blocked
# noDeletePaths:   read/write/edit allowed, delete blocked
#
# Supports: literal paths (~/.ssh/, /etc/) and globs (*.pem, *.lock)

bashToolPatterns:
  - pattern: '\\brm\\s+-[rRf]'
    reason: rm with recursive or force flags

  - pattern: '\\bsudo\\b'
    reason: sudo command execution

  - pattern: '\\bgit\\s+push\\s+.*--force'
    reason: git push --force
    ask: true

  - pattern: '\\bcurl\\s+.*\\|\\s*(ba)?sh'
    reason: curl piped to bash

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
`;
