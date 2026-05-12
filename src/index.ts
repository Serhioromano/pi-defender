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
 *   - Interactive selector UI with approve/deny/approve-all/whitelist options
 *   - Strict mode whitelist: auto-approve remembered commands
 *   - YAML configuration (project-local or global)
 *   - Management commands: /defender:reload, /defender:status, /defender:patterns, /defender:strict
 *
 * Previously: pi-damage-control
 * Inspired by: https://github.com/disler/claude-code-damage-control
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadConfig, checkCommand, checkFileAccess, checkWhitelist, generateWhitelistPattern, addPatternToWhitelist, type Config } from "./config";

// =============================================================================
// EXTENSION
// =============================================================================

export default function (pi: ExtensionAPI) {
  let currentConfig: Config | null = null;
  let stats = { blocked: 0, asked: 0, allowed: 0, strictBlocked: 0, strictApproved: 0, strictApprovedAll: 0 };
  let strictMode = false;
  let approveAllSession = false;
  let aborted = false;
  let needsInitNotify = true;

  function getConfig(cwd: string): Config {
    if (currentConfig) return currentConfig;
    currentConfig = loadConfig(cwd);
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
  // PATTERN-BLOCKED SELECTOR (patterns.yaml violations)
  // ===========================================================================

  async function patternBlockedPrompt(ctx: any, command: string, reason: string): Promise<"allow" | "deny"> {
    const displayCmd = command.length > 80 ? command.slice(0, 77) + "..." : command;
    const displayReason = reason.length > 100 ? reason.slice(0, 97) + "..." : reason;

    if (typeof ctx.ui?.custom === "function") {
      try {
        const result = await ctx.ui.custom(
          (_tui: any, theme: any, _kb: any, done: (value: string) => void) => {
            let selectedIndex = 0;
            const options = [
              { value: "allow", label: "⚠️ Allow anyway (dangerous)" },
              { value: "deny", label: "❌ Deny & Abort (stop entire prompt)" },
            ];

            function render(width: number): string[] {
              const lines: string[] = [];
              const sep = "─".repeat(Math.min(width, 80));
              lines.push(theme.fg("warning", sep));
              lines.push(theme.fg("warning", theme.bold(" 🛡️ BLOCKED by patterns.yaml")));
              lines.push("");
              lines.push(theme.fg("dim", `  ${displayCmd}`));
              lines.push("");
              lines.push(theme.fg("warning", `  Reason: ${displayReason}`));
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
              lines.push(theme.fg("warning", sep));
              return lines;
            }

            return {
              render,
              invalidate: () => { },
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
        return (result ?? "deny") as "allow" | "deny";
      } catch {
        // Fall through to confirm fallback
      }
    }

    // Fallback: confirm dialog
    if (typeof ctx.ui?.confirm === "function") {
      const allowed = await ctx.ui.confirm(
        "🛡️ BLOCKED by patterns.yaml",
        `${displayCmd}\n\nReason: ${displayReason}\n\nAllow this dangerous command anyway?\n(No = deny & abort entire prompt)`,
      );
      return allowed ? "allow" : "deny";
    }

    // No UI — deny by default
    return "deny";
  }

  // ===========================================================================
  // STRICT MODE SELECTOR
  // ===========================================================================

  async function strictModePrompt(ctx: any, command: string): Promise<"approve" | "deny" | "approve_all" | "abort" | "whitelist"> {
    const displayCmd = command.length > 80 ? command.slice(0, 77) + "..." : command;

    // Try custom UI selector first
    if (typeof ctx.ui?.custom === "function") {
      try {
        const result = await ctx.ui.custom(
          (_tui: any, theme: any, _kb: any, done: (value: string) => void) => {
            let selectedIndex = 0;
            const options = [
              { value: "approve", label: "✅ Approve this command" },
              { value: "whitelist", label: "📋 Approve & Whitelist (remember for future)" },
              { value: "approve_all", label: "⭐ Approve ALL session (skip future prompts for safe commands)" },
              { value: "deny", label: "⚠️ Deny (try something else)" },
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
              invalidate: () => { },
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
        return (result ?? "deny") as "approve" | "deny" | "approve_all" | "abort" | "whitelist";
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

  pi.on("message_start", async (event, ctx) => {
    aborted = false;
  });

  pi.on("message_end", async (event, ctx) => {
    aborted = false;
  });

  // ===========================================================================
  // TOOL CALL INTERCEPTION — Bash
  // ===========================================================================

  pi.on("tool_call", async (event, ctx) => {
    // Show "Defender active" on extension init (covers /reload)
    if (needsInitNotify) {
      needsInitNotify = false;
      const config = getConfig(ctx.cwd);
      ctx.ui.notify(
        `🛡️ Defender active (${config.bashToolPatterns.length} patterns, ${config.zeroAccessPaths.length} zero-access, ${config.readOnlyPaths.length} read-only)`,
        "info",
      );
    }

    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    if (!command) return undefined;

    const config = getConfig(ctx.cwd);
    const result = checkCommand(command, config);

    // 1. PATTERNS.YAML BLOCKED — prompt user (allow or deny & abort)
    if (result.blocked) {
      stats.blocked++;

      // No UI — block
      if (!ctx.hasUI) {
        ctx.ui.notify(`🛡️ BLOCKED by patterns.yaml: ${result.reason}`, "error");
        return { block: true, reason: `Blocked by patterns.yaml: ${result.reason}` };
      }

      // Show selector: Allow / Deny & Abort
      const choice = await patternBlockedPrompt(ctx, command, result.reason);

      if (choice === "deny") {
        aborted = true;
        stats.strictBlocked++;
        ctx.ui.notify(
          `🛡️❌ Denied & Aborted — patterns.yaml: ${result.reason}. Use /defender:strict off to reset.`,
          "error",
        );
        // Cancel the agent's turn to prevent it from trying alternative approaches
        ctx.abort?.();
        return { block: true, reason: `Denied by user (patterns.yaml: ${result.reason}) — execution aborted` };
      }

      // User allowed the dangerous command
      ctx.ui.notify(
        `⚠️ Allowed by user (patterns.yaml: ${result.reason}) — ${command.length > 60 ? command.slice(0, 57) + "..." : command}`,
        "warning",
      );
      stats.allowed++;
      return undefined;
    }

    // 2. ABORTED STATE — block all bash after user aborted
    if (aborted) {
      stats.strictBlocked++;
      ctx.ui.notify(
        `🛡️❌ Execution ABORTED by user — all bash commands blocked. Use /defender:strict off to reset.`,
        "error",
      );
      ctx.abort?.();
      return { block: true, reason: "Execution aborted by user — use /defender:strict off to reset" };
    }

    // 3. STRICT MODE — block all bash unless approved
    if (strictMode) {
      // Check whitelist first — auto-approve if command matches a whitelisted pattern
      const whitelistCheck = checkWhitelist(command, config);
      if (whitelistCheck.matched) {
        stats.strictApproved++;
        ctx.ui.notify(
          `🛡️🔒 Strict Mode: whitelisted ✅ — pattern: \`${whitelistCheck.pattern}\` — ${command.length > 60 ? command.slice(0, 57) + "..." : command}`,
          "info",
        );
        return undefined;
      }

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
        // Cancel the agent's turn to prevent it from trying alternative approaches
        ctx.abort?.();
        return { block: true, reason: "Execution aborted by user — use /defender:strict off to reset" };
      }

      if (choice === "whitelist") {
        // Generate a regex pattern from the command and save to .pi/patterns.yaml
        const whitelistPattern = generateWhitelistPattern(command);
        const result = addPatternToWhitelist(ctx.cwd, whitelistPattern);

        if (result.added) {
          // Reload config to pick up the new whitelist entry
          currentConfig = null;
          stats.strictApproved++;
          ctx.ui.notify(
            `🛡️🔒 Strict Mode: whitelisted 📋 — pattern \`${whitelistPattern}\` saved to .pi/patterns.yaml`,
            "info",
          );
        } else {
          stats.strictApproved++;
          ctx.ui.notify(
            `🛡️🔒 Strict Mode: approved (whitelist save: ${result.reason}) — ${command.length > 60 ? command.slice(0, 57) + "..." : command}`,
            "warning",
          );
        }
        return undefined;
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

    return undefined;
  });

  // ===========================================================================
  // TOOL CALL INTERCEPTION — Write / Edit
  // ===========================================================================

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    // Block all file writes/edits when execution is aborted
    if (aborted) {
      ctx.ui.notify(
        `🛡️❌ Execution ABORTED — file operations blocked. Use /defender:strict off to reset.`,
        "error",
      );
      return { block: true, reason: "Execution aborted — use /defender:strict off to reset" };
    }

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
        `  Whitelist patterns: ${config.strictModeWhiteList.length}\n` +
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
        `🛡️ Defender active (${config.bashToolPatterns.length} patterns, ${config.zeroAccessPaths.length} zero-access, ${config.readOnlyPaths.length} read-only)`,
        "info",
      );
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
            "   • Select ✅ Approve / ⚠️ Deny / ⭐ Approve All / 📋 Whitelist / ❌ Abort\n" +
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
            "   • Select ✅ Approve / ⚠️ Deny / ⭐ Approve All / 📋 Whitelist / ❌ Abort\n" +
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
    aborted = false;
    approveAllSession = false;
  });
}

// =============================================================================
// PATTERNS YAML TEMPLATE
// =============================================================================

