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
import { isToolCallEventType, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, decodeKittyPrintable } from "@earendil-works/pi-tui";
import { loadConfig, checkCommand, checkFileAccess, checkWhitelist, generateWhitelistPatterns, addPatternsToWhitelist, splitChainCommands, type Config } from "./config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-ignore — __dirname is CJS global made available by the runtime
const DEFENDER_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;
  } catch {
    return "?";
  }
})();

// =============================================================================
// EXTENSION
// =============================================================================

export default function (pi: ExtensionAPI) {
  let currentConfig: Config | null = null;
  let stats = { blocked: 0, asked: 0, allowed: 0, strictBlocked: 0, strictApproved: 0, strictApprovedAll: 0 };
  let strictMode = true; // ON by default
  let approveAllSession = false;
  let aborted = false;
  let needsInitNotify = true;
  let savedTheme: any = null;

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
      `🛡️ Defender v${DEFENDER_VERSION} active 🔒 Strict Mode ON (${config.bashToolPatterns.length} patterns, ${config.zeroAccessPaths.length} zero-access, ${config.readOnlyPaths.length} read-only)`,
      "info",
    );
  });

  // ===========================================================================
  // PATTERN-BLOCKED SELECTOR (patterns.yaml violations)
  // ===========================================================================

  /**
   * Format a single command for display — truncates if too long.
   */
  function formatCommandForDisplay(command: string, maxChars: number = 300): string[] {
    const text = command.length > maxChars ? command.slice(0, maxChars - 3) + "..." : command;
    return [text];
  }

  async function patternBlockedPrompt(ctx: any, command: string, reason: string, stepInfo?: string): Promise<"allow" | "deny"> {
    const cmdLines = formatCommandForDisplay(command);
    const displayReason = reason.length > 100 ? reason.slice(0, 97) + "..." : reason;

    if (typeof ctx.ui?.custom === "function") {
      try {
        const result = await ctx.ui.custom(
          (_tui: any, theme: any, _kb: any, done: (value: string) => void) => {
            savedTheme = theme;
            let selectedIndex = 0;
            const options = [
              { value: "allow", label: "⚠️ Allow anyway (dangerous)" },
              { value: "deny", label: "❌ Deny & Abort (stop entire prompt)" },
            ];

            function render(width: number): string[] {
              const lines: string[] = [];
              const sep = "─".repeat(Math.min(width, 80));
              const stepTag = stepInfo ? ` ${stepInfo}` : "";
              lines.push(theme.fg("warning", sep));
              lines.push(theme.fg("warning", theme.bold(` 🛡️ BLOCKED by patterns.yaml${stepTag}`)));
              lines.push("");
              lines.push(theme.fg("warning", theme.bold(" Command:")));
              for (const cmdLine of cmdLines) {
                lines.push(theme.fg("accent", `  ${cmdLine}`));
              }
              lines.push("");
              lines.push(theme.fg("warning", `  Reason: ${displayReason}`));
              lines.push("");
              for (let i = 0; i < options.length; i++) {
                const isSelected = i === selectedIndex;
                const prefix = isSelected ? theme.fg("accent", "▶") : " ";
                const numTag = `[${i + 1}]`;
                const linePrefix = `${prefix} ${numTag}`;
                if (isSelected) {
                  lines.push(` ${linePrefix} ${theme.fg("accent", options[i].label)}`);
                } else {
                  lines.push(` ${linePrefix} ${options[i].label}`);
                }
              }
              lines.push("");
              lines.push(theme.fg("dim", " ↑↓ navigate · 1-N select · enter confirm · esc deny"));
              lines.push(theme.fg("warning", sep));
              return lines;
            }

            return {
              render,
              invalidate: () => { },
              handleInput: (data: string) => {
                if (matchesKey(data, Key.up) || data === "k") {
                  selectedIndex = (selectedIndex - 1 + options.length) % options.length;
                  _tui.requestRender();
                } else if (matchesKey(data, Key.down) || data === "j") {
                  selectedIndex = (selectedIndex + 1) % options.length;
                  _tui.requestRender();
                } else if (matchesKey(data, Key.enter)) {
                  done(options[selectedIndex].value);
                } else if (matchesKey(data, Key.escape)) {
                  done("deny");
                } else {
                  const printable = decodeKittyPrintable(data) || data;
                  if (printable >= "1" && printable <= "9") {
                    const idx = parseInt(printable, 10) - 1;
                    if (idx >= 0 && idx < options.length) {
                      done(options[idx].value);
                    }
                  }
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
      const cmdPreview = cmdLines.join("\n");
      const title = stepInfo ? `🛡️ BLOCKED by patterns.yaml ${stepInfo}` : "🛡️ BLOCKED by patterns.yaml";
      const allowed = await ctx.ui.confirm(
        title,
        `${cmdPreview}\n\nReason: ${displayReason}\n\nAllow this dangerous command anyway?\n(No = deny & abort entire prompt)`,
      );
      return allowed ? "allow" : "deny";
    }

    // No UI — deny by default
    return "deny";
  }

  // ===========================================================================
  // STRICT MODE SELECTOR
  // ===========================================================================

  async function strictModePrompt(ctx: any, command: string, stepInfo?: string): Promise<"approve" | "deny" | "approve_all" | "abort" | "whitelist"> {
    const cmdLines = formatCommandForDisplay(command);

    // Try custom UI selector first
    if (typeof ctx.ui?.custom === "function") {
      try {
        const result = await ctx.ui.custom(
          (_tui: any, theme: any, _kb: any, done: (value: string) => void) => {
            savedTheme = theme;
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
              const stepTag = stepInfo ? ` ${stepInfo}` : "";
              lines.push(theme.fg("warning", sep));
              lines.push(theme.fg("warning", theme.bold(` 🛡️🔒 Strict Mode — Bash Command${stepTag}`)));
              lines.push(`  ${theme.fg("muted","Run")}  ${theme.fg("mdLink", "/defender:strict off")} ${theme.fg("muted", "to turn Strict Mode off and stop these prompts to popup.")}`);
              lines.push("");
              lines.push(theme.fg("warning", theme.bold(" Command:")));
              for (const cmdLine of cmdLines) {
                lines.push(theme.fg("accent", `  ${cmdLine}`));
              }
              lines.push("");
              for (let i = 0; i < options.length; i++) {
                const isSelected = i === selectedIndex;
                const prefix = isSelected ? theme.fg("accent", "▶") : " ";
                const numTag = `[${i + 1}]`;
                const linePrefix = `${prefix} ${numTag}`;
                if (isSelected) {
                  lines.push(` ${linePrefix} ${theme.fg("accent", options[i].label)}`);
                } else {
                  lines.push(` ${linePrefix} ${options[i].label}`);
                }
              }
              lines.push("");
              lines.push(theme.fg("dim", " ↑↓ navigate · 1-N select · enter confirm · esc deny"));
              lines.push(theme.fg("accent", sep));
              return lines;
            }

            return {
              render,
              invalidate: () => { },
              handleInput: (data: string) => {
                if (matchesKey(data, Key.up) || data === "k") {
                  selectedIndex = (selectedIndex - 1 + options.length) % options.length;
                  _tui.requestRender();
                } else if (matchesKey(data, Key.down) || data === "j") {
                  selectedIndex = (selectedIndex + 1) % options.length;
                  _tui.requestRender();
                } else if (matchesKey(data, Key.enter)) {
                  done(options[selectedIndex].value);
                } else if (matchesKey(data, Key.escape)) {
                  done("deny");
                } else {
                  const printable = decodeKittyPrintable(data) || data;
                  if (printable >= "1" && printable <= "9") {
                    const idx = parseInt(printable, 10) - 1;
                    if (idx >= 0 && idx < options.length) {
                      done(options[idx].value);
                    }
                  }
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
      const cmdPreview = cmdLines.join("\n");
      const title = stepInfo ? `🛡️🔒 Strict Mode — Bash Command ${stepInfo}` : "🛡️🔒 Strict Mode — Bash Command";
      const choice = await ctx.ui.confirm(
        title,
        `Command:\n${cmdPreview}\n\nAllow this command?\n\n(No = deny, Esc = abort via /defender:strict off)`,
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
        `🛡️ Defender v${DEFENDER_VERSION} active 🔒 Strict Mode ON (${config.bashToolPatterns.length} patterns, ${config.zeroAccessPaths.length} zero-access, ${config.readOnlyPaths.length} read-only)`,
        "info",
      );
    }

    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    if (!command) return undefined;

    const config = getConfig(ctx.cwd);

    // Split chained commands (&&, ||, ;) — each sub-command gets individual approval
    const subCommands = splitChainCommands(command);

    // Helper: small delay between sub-command prompts for TUI stability.
    // Without this, the second ctx.ui.custom() may conflict with the first's
    // teardown, causing the second selector to never render.
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

    // Process each sub-command through the full approval pipeline independently
    // Collect all sub-command decisions for combined notification at the end
    interface SubDecision { cmd: string; type: "approved" | "whitelisted" | "approved-all"; }
    const decisions: SubDecision[] = [];
    for (let idx = 0; idx < subCommands.length; idx++) {
      const subCmd = subCommands[idx];
      const stepInfo = subCommands.length > 1 ? `(${idx + 1}/${subCommands.length})` : undefined;

      // Small delay between selectors — gives TUI time to tear down previous one
      if (idx > 0) {
        await delay(150);
      }

      const result = checkCommand(subCmd, config);

      // ----- 1. PATTERNS.YAML BLOCKED (per sub-command) -----
      if (result.blocked) {
        stats.blocked++;

        if (!ctx.hasUI) {
          ctx.ui.notify(`🛡️ BLOCKED by patterns.yaml: ${result.reason}`, "error");
          return { block: true, reason: `Blocked by patterns.yaml: ${result.reason}` };
        }

        const choice = await patternBlockedPrompt(ctx, subCmd, result.reason, stepInfo);

        if (choice === "deny") {
          aborted = true;
          stats.strictBlocked++;
          ctx.ui.notify(
            `🛡️❌ Denied & Aborted — patterns.yaml: ${result.reason}. Use /defender:strict off to reset.`,
            "error",
          );
          ctx.abort?.();
          return { block: true, reason: `Denied by user (patterns.yaml: ${result.reason}) — execution aborted` };
        }

        // User allowed this dangerous sub-command — skip strict mode for it, continue to next
        ctx.ui.notify(
          `⚠️ Allowed by user (patterns.yaml: ${result.reason}) — ${subCmd.length > 60 ? subCmd.slice(0, 57) + "..." : subCmd}`,
          "warning",
        );
        stats.allowed++;
        continue;
      }

      // ----- 2. ABORTED STATE -----
      if (aborted) {
        stats.strictBlocked++;
        ctx.ui.notify(
          `🛡️❌ Execution ABORTED by user — all bash commands blocked. Use /defender:strict off to reset.`,
          "error",
        );
        ctx.abort?.();
        return { block: true, reason: "Execution aborted by user — use /defender:strict off to reset" };
      }

      // ----- 3. STRICT MODE (per sub-command) -----
      if (strictMode) {
        // Check whitelist for this individual sub-command
        const whitelistCheck = checkWhitelist(subCmd, config);
        if (whitelistCheck.matched) {
          stats.strictApproved++;
          decisions.push({ cmd: subCmd, type: "whitelisted" });
          continue;
        }

        // approveAllSession auto-approves commands not blocked by patterns.yaml
        if (approveAllSession) {
          stats.strictApproved++;
          decisions.push({ cmd: subCmd, type: "approved-all" });
          continue;
        }

        if (!ctx.hasUI) {
          stats.strictBlocked++;
          ctx.ui.notify(`🛡️🔒 ${savedTheme.fg("warning", "Strict Mode")}: blocked (no UI) — use /defender:strict off to disable`, "error");
          return { block: true, reason: "Strict mode active — all bash commands require approval (no UI available)" };
        }

        // Show selector for this individual sub-command
        const choice = await strictModePrompt(ctx, subCmd, stepInfo);

        if (choice === "deny") {
          stats.strictBlocked++;
          ctx.ui.notify(`🛡️🔒 ${savedTheme.fg("warning", "Strict Mode")}: denied — try something else`, "warning");
          return { block: true, reason: "Blocked by user in strict mode — try a different approach" };
        }

        if (choice === "abort") {
          aborted = true;
          stats.strictBlocked++;
          ctx.ui.notify(
            `🛡️❌ Execution ABORTED by user — all bash commands now blocked. Use /defender:strict off to reset.`,
            "error",
          );
          ctx.abort?.();
          return { block: true, reason: "Execution aborted by user — use /defender:strict off to reset" };
        }

        if (choice === "whitelist") {
          // Generate a regex pattern for this individual sub-command
          const whitelistPatterns = generateWhitelistPatterns(subCmd);
          const addResult = addPatternsToWhitelist(ctx.cwd, whitelistPatterns);

          // Reload config to pick up new whitelist entries
          currentConfig = null;

          stats.strictApproved++;
          decisions.push({ cmd: subCmd, type: "whitelisted" });
          continue;
        }

        if (choice === "approve_all") {
          approveAllSession = true;
          stats.strictApprovedAll++;
          decisions.push({ cmd: subCmd, type: "approved-all" });
        } else {
          stats.strictApproved++;
        }
        decisions.push({ cmd: subCmd, type: "approved" });
        continue;
      }
    }

    // Show unified notification — same format for single and chain commands
    if (decisions.length > 0) {
      const lines = decisions.map(d => {
        const labels = {
          approved: "✅ Approved",
          "approved-all": "⭐ Approved all",
          whitelisted: "📋 Whitelisted",
        };
        const label = labels[d.type] || "✅ Approved";
        const cmdText = d.cmd.length > 35 ? d.cmd.slice(0, 32) + "..." : d.cmd;
        return `  ${label}: ${savedTheme.fg("accent", cmdText)}`;
      }).join("\n");
      ctx.ui.notify(
        `🛡️🔒 ${savedTheme.fg("warning", "Strict Mode")} actions:\n${lines}`,
        "info",
      );
    }

    // All sub-commands approved — allow the full chained command to run
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
        ? `🔒 ACTIVE (default)${approveAllSession ? " (approve-all session)" : ""}${abortStatus}`
        : aborted
          ? `❌ ABORTED (use /defender:strict off to reset)`
          : "⚪ OFF (non-default)";
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
        `🛡️ Defender v${DEFENDER_VERSION} active 🔒 Strict Mode ON (${config.bashToolPatterns.length} patterns, ${config.zeroAccessPaths.length} zero-access, ${config.readOnlyPaths.length} read-only)`,
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
          ctx.ui.notify("🛡️🔒 Strict Mode is already ACTIVE (default)", "warning");
        } else {
          strictMode = true;
          approveAllSession = false;
          aborted = false;
          ctx.ui.notify(
            `🛡️🔒 ${savedTheme.fg("warning", "Strict Mode")} ACTIVATED (default) — ALL bash commands now require your approval\n` +
            "   • Select ✅ Approve / ⚠️ Deny / ⭐ Approve All / 📋 Whitelist / ❌ Abort\n" +
            "   • patterns.yaml blocked rules are ALWAYS enforced\n" +
            "   • /defender:strict off to disable",
            "info",
          );
        }
      } else if (mode === "off") {
        if (!strictMode && !aborted) {
          ctx.ui.notify("🛡️ Strict Mode is already OFF (non-default)", "warning");
        } else {
          strictMode = false;
          approveAllSession = false;
          aborted = false;
          ctx.ui.notify(
            `🛡️ ${savedTheme.fg("warning", "Strict Mode")} DEACTIVATED — normal protection restored (patterns.yaml rules only). Use /defender:strict on to re-enable.`,
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
            `🛡️ ${savedTheme.fg("warning", "Strict Mode")} DEACTIVATED — normal protection restored (patterns.yaml rules only). Use /defender:strict on to re-enable.`,
            "info",
          );
        } else {
          // Turning ON
          strictMode = true;
          approveAllSession = false;
          aborted = false;
          ctx.ui.notify(
            `🛡️🔒 ${savedTheme.fg("warning", "Strict Mode")} ACTIVATED (default) — ALL bash commands now require your approval\n` +
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

