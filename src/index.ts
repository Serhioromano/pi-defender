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
import { matchesKey, Key, decodeKittyPrintable, truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig, checkCommand, checkFileAccess, checkWhitelist, generateWhitelistPatterns, addPatternsToWhitelist, splitChainCommands, formatConfigTable, ensurePatternsConfig, type Config, type LoadedConfig } from "./config";
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
  let currentLoadedConfig: LoadedConfig | null = null;
  let stats = { blocked: 0, asked: 0, allowed: 0, strictBlocked: 0, strictApproved: 0, strictApprovedAll: 0 };
  let strictMode = true; // ON by default
  const sessionApprovedPatterns: string[] = []; // session-scoped approve-all patterns (regex-escaped commands)
  let aborted = false;
  let defenderDisabled = false; // set by session-start "Disable Defender" — skips ALL tool_call analysis
  let savedTheme: any = null;

  function getConfig(cwd: string): Config {
    return getLoadedConfig(cwd).config;
  }

  function getLoadedConfig(cwd: string): LoadedConfig {
    if (currentLoadedConfig) return currentLoadedConfig;
    currentLoadedConfig = loadConfig(cwd);
    return currentLoadedConfig;
  }

  // ===========================================================================
  // SESSION START
  // ===========================================================================

  pi.on("session_start", async (_event, ctx) => {
    // Deploy bundled defaults to .pi if missing (idempotent)
    ensurePatternsConfig(ctx.cwd);

    const loaded = getLoadedConfig(ctx.cwd);

    if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
      // No UI — default to strict mode ON with table notification
      strictMode = true;
      ctx.ui.notify(
        formatConfigTable(loaded, DEFENDER_VERSION, true, false),
        "info",
      );
      return;
    }

    try {
      const result = await ctx.ui.custom(
        (_tui: any, theme: any, _kb: any, done: (value: string) => void) => {
          savedTheme = theme;
          let selectedIndex = 0;
          const options = [
            { value: "strict", label: "🔒 Strict Mode ON (recommended)", desc: "Every bash command goes through filtering or approval" },
            { value: "patterns", label: "🛡️ Patterns only", desc: "Only patterns.yaml blocked rules are enforced for confirmation" },
            { value: "off", label: "⚪ Disable Defender", desc: "No protection — use `/defender:strict on` to re-enable" },
          ];

          function render(width: number): string[] {
            const lines: string[] = [];
            const sep = "─".repeat(Math.min(width, 74));
            lines.push(theme.fg("accent", sep));
            lines.push(theme.fg("accent", theme.bold(` 🛡️ Pi Defender v${DEFENDER_VERSION}`)));
            lines.push("");
            lines.push(theme.fg("warning", " Choose protection level for this session:"));
            lines.push("");
            for (let i = 0; i < options.length; i++) {
              const isSelected = i === selectedIndex;
              const prefix = isSelected ? theme.fg("accent", "▶") : " ";
              const numTag = `[${i + 1}]`;
              const linePrefix = ` ${prefix} ${numTag}`;
              if (isSelected) {
                lines.push(` ${linePrefix} ${theme.fg("accent", options[i].label)}`);
                lines.push(`        ${theme.fg("dim", options[i].desc)}`);
              } else {
                lines.push(` ${linePrefix} ${options[i].label}`);
                lines.push(`        ${theme.fg("dim", options[i].desc)}`);
              }
            }
            lines.push("");
            lines.push(theme.fg("dim", " ↑↓ navigate · 1-N select · enter confirm"));
            lines.push(theme.fg("accent", sep));
            return lines;
          }

          return {
            render,
            invalidate: () => {},
            handleInput: (data: string) => {
              const digit = decodeKittyPrintable(data) || data;
              if (/^[1-3]$/.test(digit)) {
                done(options[parseInt(digit) - 1].value);
                return;
              }
              if (matchesKey(data, Key.enter)) {
                done(options[selectedIndex].value);
                return;
              }
              if (matchesKey(data, Key.up) || data === "k") {
                selectedIndex = (selectedIndex - 1 + options.length) % options.length;
                _tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.down) || data === "j") {
                selectedIndex = (selectedIndex + 1) % options.length;
                _tui.requestRender();
                return;
              }
            },
          };
        },
      );

      const choice = (result ?? "strict") as string;
      if (choice === "off") {
        strictMode = false;
        defenderDisabled = true;
        ctx.ui.notify(
          formatConfigTable(loaded, DEFENDER_VERSION, false, true),
          "warning",
        );
      } else if (choice === "patterns") {
        strictMode = false;
        defenderDisabled = false;
        ctx.ui.notify(
          formatConfigTable(loaded, DEFENDER_VERSION, false, false),
          "info",
        );
      } else {
        strictMode = true;
        defenderDisabled = false;
        ctx.ui.notify(
          formatConfigTable(loaded, DEFENDER_VERSION, true, false),
          "info",
        );
      }
    } catch {
      // Fallback if custom UI fails
      strictMode = true;
      ctx.ui.notify(
        formatConfigTable(loaded, DEFENDER_VERSION, true, false),
        "info",
      );
    }
  });

  // ===========================================================================
  // PATTERN-BLOCKED SELECTOR (patterns.yaml violations)
  // ===========================================================================

  /**
   * Check if a command matches any session-approved (approve-all) pattern.
   * Works the same as checkWhitelist but against in-memory sessionApprovedPatterns.
   */
  function checkSessionApproved(command: string, patterns: string[]): { matched: boolean } {
    const subCommands = splitChainCommands(command);
    if (subCommands.length === 0) return { matched: false };

    for (const sub of subCommands) {
      let subMatched = false;
      for (const pattern of patterns) {
        try {
          const regex = new RegExp(pattern, "i");
          if (regex.test(sub)) {
            subMatched = true;
            break;
          }
        } catch {
          continue;
        }
      }
      if (!subMatched) return { matched: false };
    }
    return { matched: true };
  }

  /**
   * Format a single command for display — truncates to fit terminal width.
   * When maxWidth is provided, uses truncateToWidth for ANSI-aware truncation.
   * Falls back to character-based truncation at 300 chars when no width given.
   */
  function formatCommandForDisplay(command: string, maxWidth?: number): string[] {
    if (maxWidth !== undefined && maxWidth > 0) {
      return [truncateToWidth(command, maxWidth)];
    }
    const maxChars = 300;
    const text = command.length > maxChars ? command.slice(0, maxChars - 3) + "..." : command;
    return [text];
  }

  async function patternBlockedPrompt(ctx: any, command: string, reason: string, stepInfo?: string): Promise<"allow" | "deny"> {
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
              const cmdMaxWidth = Math.max(1, width - 2); // "  " indent
              lines.push(theme.fg("warning", sep));
              lines.push(theme.fg("warning", theme.bold(` 🛡️ BLOCKED by patterns.yaml${stepTag}`)));
              lines.push("");
              lines.push(theme.fg("warning", theme.bold(" Command:")));
              for (const cmdLine of formatCommandForDisplay(command, cmdMaxWidth)) {
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
      const cmdPreview = formatCommandForDisplay(command).join("\n");
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
              { value: "approve_all", label: "⭐ Approve ALL (auto-approve future occurrences of THIS command)" },
              { value: "deny", label: "⚠️ Deny (try something else)" },
              { value: "abort", label: "❌ Abort (stop all execution)" },
            ];

            function render(width: number): string[] {
              const lines: string[] = [];
              const sep = "─".repeat(Math.min(width, 80));
              const stepTag = stepInfo ? ` ${stepInfo}` : "";
              const cmdMaxWidth = Math.max(1, width - 2); // "  " indent
              lines.push(theme.fg("warning", sep));
              lines.push(theme.fg("warning", theme.bold(` 🛡️🔒 Strict Mode — Bash Command${stepTag}`)));
              lines.push(`  ${theme.fg("muted","Run")}  ${theme.fg("mdLink", "/defender:strict off")} ${theme.fg("muted", "to turn Strict Mode off and stop these prompts to popup.")}`);
              lines.push("");
              lines.push(theme.fg("warning", theme.bold(" Command:")));
              for (const cmdLine of formatCommandForDisplay(command, cmdMaxWidth)) {
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
      const cmdPreview = formatCommandForDisplay(command).join("\n");
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

  pi.on("message_start", async (_event, _ctx) => {
    aborted = false;
    sessionApprovedPatterns.length = 0; // clear approve-all patterns each new prompt
  });

  pi.on("message_end", async (_event, _ctx) => {
    aborted = false;
  });

  // ===========================================================================
  // TOOL CALL INTERCEPTION — Bash
  // ===========================================================================

  pi.on("tool_call", async (event, ctx) => {
    if (defenderDisabled) return undefined;
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
    interface SubDecision { cmd: string; type: "approved" | "whitelisted" | "approved-all"; pattern?: string; }
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
          decisions.push({ cmd: subCmd, type: "whitelisted", pattern: whitelistCheck.pattern });
          continue;
        }

        // Session-approved patterns: auto-approve commands matching a previously "Approve All"-ed pattern
        const sessionApprovedCheck = checkSessionApproved(subCmd, sessionApprovedPatterns);
        if (sessionApprovedCheck.matched) {
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
          currentLoadedConfig = null;

          stats.strictApproved++;
          decisions.push({ cmd: subCmd, type: "whitelisted", pattern: whitelistPatterns[0] || "" });
          continue;
        }

        if (choice === "approve_all") {
          // Add this command's pattern to session-approved set (NOT global approve-all)
          const patterns = generateWhitelistPatterns(subCmd);
          for (const p of patterns) {
            if (!sessionApprovedPatterns.includes(p)) {
              sessionApprovedPatterns.push(p);
            }
          }
          stats.strictApprovedAll++;
          decisions.push({ cmd: subCmd, type: "approved-all" });
        } else {
          stats.strictApproved++;
          decisions.push({ cmd: subCmd, type: "approved" });
        }
        continue;
      }
    }

    // Show unified notification — same format for single and chain commands
    if (decisions.length > 0) {
      const labels = {
        approved: "✅ Approved",
        "approved-all": "⭐ Approved all",
        whitelisted: "📋 Whitelisted",
      };
      // Guard against null theme — happens when ALL sub-commands are whitelisted
      // and no prompt ever fired, so savedTheme was never captured.
      // Arrow function reads savedTheme at call time, not definition time.
      const fg = (color: string, text: string) =>
        savedTheme ? savedTheme.fg(color, text) : text;
      const lines: string[] = [];
      for (const d of decisions) {
        const label = labels[d.type] || "✅ Approved";
        const cmdText = d.cmd.length > 35 ? d.cmd.slice(0, 32) + "..." : d.cmd;
        const prefix = `  ${label}: `;
        lines.push(`${prefix}${savedTheme.fg("accent", cmdText)}`);
        if (d.pattern) {
          const indent = " ".repeat(prefix.length - 9);
          lines.push(`${indent}pattern: ${savedTheme.fg("mdLink", `${d.pattern}`)}`);
        }
      }
      ctx.ui.notify(
        `🛡️🔒 ${savedTheme.fg("warning", "Strict Mode")} actions:\n${lines.join("\n")}`,
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
    if (defenderDisabled) return undefined;
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
    if (defenderDisabled) return undefined;
    if (!isToolCallEventType("read", event)) return undefined;

    // Reads are allowed during abort for diagnostics, but skip if defender is disabled

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
      const loaded = getLoadedConfig(ctx.cwd);
      const config = loaded.config;
      const abortStatus = aborted ? " ❌ ABORTED" : "";
      const approveCount = sessionApprovedPatterns.length;
      const strictStatus = defenderDisabled
        ? `⚪ DISABLED (use /defender:strict on to re-enable)`
        : strictMode
          ? `🔒 ACTIVE (default)${approveCount > 0 ? ` (${approveCount} session-approved)` : ""}${abortStatus}`
          : aborted
            ? `❌ ABORTED (use /defender:strict off to reset)`
            : "⚪ OFF (non-default)";
      ctx.ui.notify(
        `🛡️  Defender Stats\n` +
        `  Allowed: ${stats.allowed} · Blocked: ${stats.blocked} · Asked: ${stats.asked}\n` +
        `  Strict: ${stats.strictApproved} approved · ${stats.strictBlocked} blocked · ${stats.strictApprovedAll} approve-all · ${sessionApprovedPatterns.length} session-approved\n` +
        `  Mode: ${strictStatus}\n` +
        `\n` +
        formatConfigTable(loaded, DEFENDER_VERSION, strictMode, defenderDisabled),
        "info",
      );
    },
  });

  pi.registerCommand("defender:reload", {
    description: "Reload defender configuration from YAML",
    handler: async (_args, ctx) => {
      currentLoadedConfig = null;
      const loaded = getLoadedConfig(ctx.cwd);
      ctx.ui.notify(
        formatConfigTable(loaded, DEFENDER_VERSION, strictMode, defenderDisabled),
        "info",
      );
    },
  });

  pi.registerCommand("defender:patterns", {
    description: "Copy bundled essential patterns to project's .pi/patterns.yaml (idempotent)",
    handler: async (_args, ctx) => {
      const result = ensurePatternsConfig(ctx.cwd);
      if (result.deployed) {
        ctx.ui.notify(
          `🛡️ Deployed essential patterns to: ${result.path}. Reloading config...`,
          "info",
        );
        currentLoadedConfig = null;
        const loaded = getLoadedConfig(ctx.cwd);
        ctx.ui.notify(
          formatConfigTable(loaded, DEFENDER_VERSION, strictMode, defenderDisabled),
          "info",
        );
      } else if (result.path) {
        ctx.ui.notify(
          `🛡️ Patterns already deployed to: ${result.path}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          "🛡️ Could not find bundled patterns.yaml source file.",
          "error",
        );
      }
    },
  });

  pi.registerCommand("defender:strict", {
    description: "Toggle strict mode — blocks ALL bash commands requiring user approval (on|off, or toggle)",
    handler: async (args, ctx) => {
      const mode = args.toLowerCase().trim();

      if (mode === "on") {
        if (strictMode && !defenderDisabled) {
          ctx.ui.notify("🛡️🔒 Strict Mode is already ACTIVE (default)", "warning");
        } else {
          strictMode = true;
          defenderDisabled = false;
          sessionApprovedPatterns.length = 0;
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
          defenderDisabled = false;
          strictMode = false;
          sessionApprovedPatterns.length = 0;
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
          sessionApprovedPatterns.length = 0;
          aborted = false;
          ctx.ui.notify(
            `🛡️ ${savedTheme.fg("warning", "Strict Mode")} DEACTIVATED — normal protection restored (patterns.yaml rules only). Use /defender:strict on to re-enable.`,
            "info",
          );
        } else {
          // Turning ON
          strictMode = true;
          defenderDisabled = false;
          sessionApprovedPatterns.length = 0;
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
    currentLoadedConfig = null;
    aborted = false;
    defenderDisabled = false;
    sessionApprovedPatterns.length = 0;
  });
}

// =============================================================================
// PATTERNS YAML TEMPLATE
// =============================================================================

