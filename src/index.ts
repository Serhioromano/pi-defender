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
 *   - Management commands: /defender:reload, /defender:status, /defender:patterns, /defender:strict, /defender:report-issue, /defender:default-mode
 *   - Custom tool: pi_defender_create_issue — creates GitHub issues via REST API (ONLY for Serhioromano/pi-defender, ONLY via /defender:report-issue)
 *   - Management commands: /defender:reload, /defender:status, /defender:patterns, /defender:strict
 *
 * Previously: pi-damage-control
 * Inspired by: https://github.com/disler/claude-code-damage-control
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, decodeKittyPrintable, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig, checkCommand, checkFileAccess, checkWhitelist, generateWhitelistPatterns, addPatternsToWhitelist, stripCommentLines, splitChainCommands, formatConfigTable, formatStatsTable, mergeWhitelistToGlobal, setDefaultMode, getChangelogDiff, readLastSeenVersion, writeLastSeenVersion, type Config, type LoadedConfig, type StatsSnapshot } from "./config";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// @ts-ignore — __dirname is a CJS global, Pi runtime may inject it even in ESM
const DEFENDER_VERSION: string = (() => {
  try {
    const dir = typeof __dirname === "string" && __dirname ? __dirname : process.cwd();
    return JSON.parse(readFileSync(join(dir, "..", "package.json"), "utf-8")).version;
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
  /** Safe accessor for savedTheme.fg — returns undefined if no theme captured yet. */
  const getFg = (): ((color: string, text: string) => string) | undefined =>
    savedTheme ? savedTheme.fg.bind(savedTheme) : undefined;
  /** Raw dim ANSI escape code — restored after accent-colored cells so text stays dim. */
  const getDimAnsi = (): string | undefined =>
    savedTheme ? (savedTheme as any).getFgAnsi?.("dim") : undefined;
  /** Safe theme formatter — applies color when theme available, returns plain text otherwise. */
  const fg = (color: string, text: string): string => (getFg() ?? ((_: string, t: string) => t))(color, text);

  function getConfig(cwd: string): Config {
    return getLoadedConfig(cwd).config;
  }

  function getLoadedConfig(cwd: string): LoadedConfig {
    if (currentLoadedConfig) return currentLoadedConfig;
    currentLoadedConfig = loadConfig(cwd);
    return currentLoadedConfig;
  }

  // ===========================================================================
  // GITHUB TOKEN RESOLUTION (multi-source, gh-free)
  // ===========================================================================

  /**
   * Try multiple sources to find a GitHub token.
   * Order: GH_TOKEN env → GITHUB_TOKEN env → `gh auth token` → ~/.config/gh/hosts.yml
   */
  function getGitHubToken(): string | null {
    // 1. Environment variables
    if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

    // 2. gh CLI auth token (if gh is installed)
    try {
      const token = execSync("gh auth token", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      if (token) return token;
    } catch { /* gh not installed or not authenticated */ }

    // 3. Parse ~/.config/gh/hosts.yml for github.com token
    try {
      const hostsPath = join(homedir(), ".config", "gh", "hosts.yml");
      if (existsSync(hostsPath)) {
        const content = readFileSync(hostsPath, "utf-8");
        // Simple YAML parsing: find oauth_token under github.com
        const match = content.match(/github\.com:\s*\n[\s\S]*?oauth_token:\s*(\S+)/);
        if (match) return match[1];
      }
    } catch { /* ignore */ }

    return null;
  }

  // ===========================================================================
  // GITHUB ISSUE CREATION TOOL (works without gh CLI)
  // ===========================================================================

  pi.registerTool({
    name: "pi_defender_create_issue",
    label: "Create GitHub Issue",
    description:
      "EXCLUSIVE to /defender:report-issue — creates a GitHub issue on the Serhioromano/pi-defender repository ONLY. " +
      "Never use for other repositories (use gh CLI instead). " +
      "Uses the GitHub REST API — no gh CLI required. " +
      "Requires a GitHub token from GH_TOKEN, GITHUB_TOKEN, or gh auth.",
    promptSnippet: "Create a GitHub issue on Serhioromano/pi-defender (ONLY via /defender:report-issue)",
    promptGuidelines: [
      "pi_defender_create_issue creates issues ONLY on Serhioromano/pi-defender repository. " +
      "NEVER use this tool unless explicitly instructed by the /defender:report-issue follow-up message. " +
      "For issues on ANY other repository, use `gh issue create` CLI instead. " +
      "The label should be 'bug' for bugs or 'enhancement' for feature requests.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Issue title (concise, descriptive, max 80 chars)" }),
      body: Type.String({ description: "Issue body in markdown, including ## Description and ## Diagnostics sections" }),
      label: Type.String({ description: "Either 'bug' or 'enhancement'" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const token = getGitHubToken();
      if (!token) {
        return {
          content: [{
            type: "text",
            text: "❌ Cannot create issue: no GitHub token found.\n\n" +
              "Set one of:\n" +
              "  • GH_TOKEN or GITHUB_TOKEN environment variable\n" +
              "  • Install and authenticate gh CLI: `gh auth login`",
          }],
          details: {},
        };
      }

      // Validate label
      const validLabels = ["bug", "enhancement"];
      const actualLabel = validLabels.includes(params.label) ? params.label : "bug";

      const response = await fetch(
        "https://api.github.com/repos/Serhioromano/pi-defender/issues",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            title: params.title,
            body: params.body,
            labels: [actualLabel],
          }),
        },
      );

      const data = await response.json() as any;

      if (!response.ok) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to create issue (HTTP ${response.status}): ${data.message || JSON.stringify(data)}`,
          }],
          details: {},
        };
      }

      return {
        content: [{
          type: "text",
          text: `✅ Issue created: ${data.html_url}\n   Title: ${data.title}\n   Label: ${actualLabel}`,
        }],
        details: { url: data.html_url, number: data.number },
      };
    },
  });

  // ===========================================================================
  // SESSION START
  // ===========================================================================

  /**
   * Apply a protection mode to the current session state (no config persistence).
   */
  function applyMode(mode: Config["defaultMode"]): void {
    if (mode === "off") {
      strictMode = false;
      defenderDisabled = true;
    } else if (mode === "patterns") {
      strictMode = false;
      defenderDisabled = false;
    } else {
      strictMode = true;
      defenderDisabled = false;
    }
  }

  /**
   * Shared protection-level selector — used by session_start and /defender:default-mode.
   * Returns the parsed choice with mode + save flags, or null if unavailable/cancelled.
   */
  async function showModeSelector(
    ctx: any,
    description: string,
  ): Promise<{ mode: Config["defaultMode"]; saveLocal: boolean; saveGlobal: boolean; } | null> {
    if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") return null;

    try {
      const result = await ctx.ui.custom(
        (_tui: any, theme: any, _kb: any, done: (value: string) => void) => {
          savedTheme = theme;
          let selectedIndex = 0;
          const modeOptions = [
            { value: "strict", label: "🔒 Strict Mode ON (recommended)", desc: "Every bash command goes through filtering or approval" },
            { value: "patterns", label: "🛡️ Patterns only", desc: "Only patterns.yaml blocked rules are enforced for confirmation" },
            { value: "off", label: "⚪ Disable Defender", desc: "No protection — use /defender:strict on to re-enable" },
          ];
          const saveOptions = [
            { checked: false, label: "💾 Save choice for this project", desc: "Writes defaultMode to .pi/defender.yaml" },
            { checked: false, label: "🌐 Save choice forever (global)", desc: "Writes defaultMode to ~/.pi/defender.yaml" },
          ];
          const totalItems = modeOptions.length + saveOptions.length;

          function render(width: number): string[] {
            const lines: string[] = [];
            const sep = "─".repeat(Math.min(width, 74));
            lines.push(theme.fg("accent", sep));
            lines.push(theme.fg("accent", theme.bold(` 🛡️ Pi Defender v${DEFENDER_VERSION}`)));
            lines.push("");
            lines.push(theme.fg("warning", description));
            lines.push("");
            for (let i = 0; i < modeOptions.length; i++) {
              const isSelected = i === selectedIndex;
              const prefix = isSelected ? theme.fg("accent", "▶") : " ";
              const numTag = `[${i + 1}]`;
              const linePrefix = ` ${prefix} ${numTag}`;
              if (isSelected) {
                lines.push(` ${linePrefix} ${theme.fg("accent", modeOptions[i].label)}`);
                lines.push(`        ${theme.fg("dim", modeOptions[i].desc)}`);
              } else {
                lines.push(` ${linePrefix} ${modeOptions[i].label}`);
                lines.push(`        ${theme.fg("dim", modeOptions[i].desc)}`);
              }
            }
            lines.push("");
            lines.push(theme.fg("dim", "─".repeat(Math.min(width - 2, 72))));
            for (let i = 0; i < saveOptions.length; i++) {
              const globalIdx = modeOptions.length + i;
              const isSelected = globalIdx === selectedIndex;
              const prefix = isSelected ? theme.fg("accent", "▶") : " ";
              const checkbox = saveOptions[i].checked
                ? theme.fg("accent", "[✓]")
                : "[ ]";
              const label = saveOptions[i].label;
              const desc = saveOptions[i].desc;
              if (isSelected) {
                lines.push(` ${prefix} ${checkbox} ${label}`);
                lines.push(`           ${theme.fg("dim", desc)}`);
              } else {
                lines.push(theme.fg("dim", ` ${prefix} ${checkbox} ${label}`));
                lines.push(`           ${theme.fg("dim", desc)}`);
              }
            }
            lines.push("");
            lines.push(theme.fg("dim", " ↑↓ navigate · 1-3 select · 4-5 toggle · enter confirm/toggle"));
            lines.push(theme.fg("accent", sep));
            return lines.map(l => truncateToWidth(l, width));
          }

          return {
            render,
            invalidate: () => { },
            handleInput: (data: string) => {
              const digit = decodeKittyPrintable(data) || data;

              if (/^[1-3]$/.test(digit)) {
                const modeIdx = parseInt(digit, 10) - 1;
                done(buildChoice(modeOptions[modeIdx].value));
                return;
              }

              if (/^[4-5]$/.test(digit)) {
                const saveIdx = parseInt(digit, 10) - 1 - modeOptions.length;
                if (saveIdx >= 0 && saveIdx < saveOptions.length) {
                  saveOptions[saveIdx].checked = !saveOptions[saveIdx].checked;
                  _tui.requestRender();
                }
                return;
              }

              if (matchesKey(data, Key.enter)) {
                if (selectedIndex < modeOptions.length) {
                  done(buildChoice(modeOptions[selectedIndex].value));
                } else {
                  const saveIdx = selectedIndex - modeOptions.length;
                  if (saveIdx >= 0 && saveIdx < saveOptions.length) {
                    saveOptions[saveIdx].checked = !saveOptions[saveIdx].checked;
                    _tui.requestRender();
                  }
                }
                return;
              }

              if (matchesKey(data, Key.up) || data === "k") {
                selectedIndex = (selectedIndex - 1 + totalItems) % totalItems;
                _tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.down) || data === "j") {
                selectedIndex = (selectedIndex + 1) % totalItems;
                _tui.requestRender();
                return;
              }
            },
          };

          function buildChoice(mode: string): string {
            const parts: string[] = [mode];
            if (saveOptions[0].checked) parts.push("save-local");
            if (saveOptions[1].checked) parts.push("save-global");
            return parts.join(":");
          }
        },
      );

      const choice = (result ?? "strict") as string;
      const choiceParts = choice.split(":");
      return {
        mode: choiceParts[0] as Config["defaultMode"],
        saveLocal: choiceParts.includes("save-local"),
        saveGlobal: choiceParts.includes("save-global"),
      };
    } catch {
      return null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const loaded = getLoadedConfig(ctx.cwd);

    // ---- VERSION CHECK — show changelog on upgrade ----
    const lastSeenVersion = readLastSeenVersion();
    if (DEFENDER_VERSION !== lastSeenVersion) {
      const changelogDiff = getChangelogDiff(DEFENDER_VERSION, lastSeenVersion);
      if (changelogDiff) {
        const header = lastSeenVersion
          ? `## 🛡️ Pi Defender updated from v${lastSeenVersion} → v${DEFENDER_VERSION}`
          : `## 🛡️ Pi Defender v${DEFENDER_VERSION} — What's New`;
        // Show changelog as a user message so markdown gets rendered by the chat UI.
        // sendUserMessage triggers a turn, but this fires once per version — worth it
        // for proper formatting.
        const fullChangelog = header + "\n\n" + changelogDiff;
        pi.sendUserMessage(fullChangelog);
      }
      // Persist the new version as seen — writes to ~/.pi/defender-version
      writeLastSeenVersion(DEFENDER_VERSION);
    }

    // defaultMode from defender.yaml — skip the interactive selector entirely
    if (loaded.config.defaultMode && loaded.config.defaultMode !== "interactive") {
      applyMode(loaded.config.defaultMode);
      const mode = loaded.config.defaultMode;
      ctx.ui.notify(
        formatConfigTable(loaded, DEFENDER_VERSION, mode === "strict", mode === "off", undefined, undefined),
        "info",
      );
      return;
    }

    // Show protection-level selector (reusable between session_start and /defender:default-mode)
    const selected = await showModeSelector(ctx, " Choose protection level for this session:");

    if (!selected) {
      // Fallback if custom UI fails or unavailable
      strictMode = true;
      ctx.ui.notify(
        formatConfigTable(loaded, DEFENDER_VERSION, true, false, getFg(), getDimAnsi()),
        "info",
      );
      return;
    }

    const { mode: modeSelected, saveLocal, saveGlobal } = selected;

    // Apply mode for this session
    applyMode(modeSelected);

    // Persist if save checkbox was ticked
    if (saveLocal || saveGlobal) {
      const saveResults: string[] = [];
      if (saveLocal) {
        const r = setDefaultMode(ctx.cwd, modeSelected, false);
        saveResults.push(r.success ? "local" : r.reason ?? "local-failed");
      }
      if (saveGlobal) {
        const r = setDefaultMode(ctx.cwd, modeSelected, true);
        saveResults.push(r.success ? "global" : r.reason ?? "global-failed");
      }

      const displayMode = modeSelected === "strict" ? "🔒 Strict Mode" : modeSelected === "patterns" ? "🛡️ Patterns only" : "⚪ Disabled";
      const successes = saveResults.filter(r => r === "local" || r === "global");
      const failures = saveResults.filter(r => r !== "local" && r !== "global");

      if (successes.length > 0) {
        const scopeLabel = successes.length === 2
          ? "both locally and globally"
          : successes[0] === "local" ? "for this project (.pi/defender.yaml)" : "globally (~/.pi/defender.yaml)";
        ctx.ui.notify(`💾 Saved default mode: ${displayMode} ${scopeLabel}. The selector will be skipped next session.`, "info");
      }
      if (failures.length > 0) {
        ctx.ui.notify(`💾 Save error(s): ${failures.join(", ")}`, "error");
      }
      // Reload config to pick up any saved defaultMode
      currentLoadedConfig = null;
    }

    ctx.ui.notify(
      formatConfigTable(getLoadedConfig(ctx.cwd), DEFENDER_VERSION, strictMode, defenderDisabled, getFg(), getDimAnsi()),
      "info",
    );
  });

  // ===========================================================================
  // PATTERN-BLOCKED SELECTOR (patterns.yaml violations)
  // ===========================================================================

  /**
   * Check if a command matches any session-approved (approve-all) pattern.
   * Works the same as checkWhitelist but against in-memory sessionApprovedPatterns.
   * Shell comment lines (#-prefixed) are stripped before matching.
   */
  function checkSessionApproved(command: string, patterns: string[]): { matched: boolean } {
    const subCommands = splitChainCommands(command);
    if (subCommands.length === 0) return { matched: false };

    for (const sub of subCommands) {
      // Strip comment lines before matching — ensures "Approve All" patterns
      // work even when the command is re-sent with # comment lines.
      const matchTarget = stripCommentLines(sub);
      let subMatched = false;
      for (const pattern of patterns) {
        try {
          const regex = new RegExp(pattern, "i");
          if (regex.test(matchTarget)) {
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
              lines.push(truncateToWidth(theme.fg("warning", `  Reason: ${displayReason}`), width));
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
              return lines.map(l => truncateToWidth(l, width));
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
              const hintLine = `  ${theme.fg("muted", "Run")}  ${theme.fg("mdLink", "/defender:strict off")} ${theme.fg("muted", "to turn Strict Mode off and stop these prompts.")}`;
              lines.push(truncateToWidth(hintLine, width));
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
              return lines.map(l => truncateToWidth(l, width));
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
          ctx.ui.notify(`🛡️🔒 ${fg("warning", "Strict Mode")}: blocked (no UI) — use /defender:strict off to disable`, "error");
          return { block: true, reason: "Strict mode active — all bash commands require approval (no UI available)" };
        }

        // Show selector for this individual sub-command
        const choice = await strictModePrompt(ctx, subCmd, stepInfo);

        if (choice === "deny") {
          stats.strictBlocked++;
          ctx.ui.notify(`🛡️🔒 ${fg("warning", "Strict Mode")}: denied — try something else`, "warning");
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
        lines.push(`${prefix}${fg("accent", cmdText)}`);
        if (d.pattern) {
          const indent = " ".repeat(prefix.length - 9);
          lines.push(`${indent}pattern: ${fg("mdLink", `${d.pattern}`)}`);
        }
      }
      ctx.ui.notify(
        `🛡️🔒 ${fg("warning", "Strict Mode")} actions:\n${lines.join("\n")}`,
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

      const st: StatsSnapshot = {
        allowed: stats.allowed,
        blocked: stats.blocked,
        asked: stats.asked,
        strictApproved: stats.strictApproved,
        strictBlocked: stats.strictBlocked,
        strictApprovedAll: stats.strictApprovedAll,
      };
      const statsTable = formatStatsTable(st, sessionApprovedPatterns.length, getFg(), getDimAnsi());
      const configTable = formatConfigTable(loaded, DEFENDER_VERSION, strictMode, defenderDisabled, getFg(), getDimAnsi());

      // Show defaultMode status
      const defaultMode = loaded.config.defaultMode;
      let defaultModeLine = "";
      if (defaultMode && defaultMode !== "interactive") {
        const icon = defaultMode === "strict" ? "🔒" : defaultMode === "patterns" ? "🛡️" : "⚪";
        const label = defaultMode === "strict" ? "Strict ON" : defaultMode === "patterns" ? "Patterns only" : "Disabled";
        defaultModeLine = `\n\n  Default mode: ${icon} ${label} (from config, selector skipped)`;
      } else {
        defaultModeLine = "\n\n  Default mode: not set (selector shown each session)";
      }

      ctx.ui.notify(
        configTable + "\n\n" + statsTable + defaultModeLine,
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
        formatConfigTable(loaded, DEFENDER_VERSION, strictMode, defenderDisabled, getFg(), getDimAnsi()),
        "info",
      );
    },
  });

  pi.registerCommand("defender:patterns", {
    description: "Show where patterns are loaded from (patterns.yaml + defender.yaml)",
    handler: async (_args, ctx) => {
      const loaded = getLoadedConfig(ctx.cwd);
      const sourceInfo = loaded.sources
        .filter(s => s.displayPath.includes("patterns.yaml"))
        .map(s => `  ${s.found ? "✅" : "❌"} ${s.displayPath}`)
        .join("\n");

      ctx.ui.notify(
        `Patterns are loaded from .pi directories (never src/ or dist/):\n` +
        sourceInfo +
        `\n\nRun /defender:reload to refresh after editing.`,
        "info",
      );
    },
  });

  pi.registerCommand("defender:globalize-whitelist", {
    description: "Copy unique local whitelist patterns to global defender.yaml",
    handler: async (_args, ctx) => {
      const result = mergeWhitelistToGlobal(ctx.cwd);

      if (result.added === 0) {
        ctx.ui.notify(
          `🛡️ Globalize whitelist: ${result.reason || "Nothing to do"}`,
          "info",
        );
      } else {
        // Reload config so the new global patterns take effect
        currentLoadedConfig = null;
        ctx.ui.notify(
          `🛡️ Globalized ${result.added} whitelist pattern(s)${result.skipped > 0 ? ` (${result.skipped} already existed in global)` : ""} from .pi/defender.yaml → ~/.pi/defender.yaml`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("defender:report-issue", {
    description: "Report an issue — AI will analyze, enhance, and create a GitHub issue",
    handler: async (args, ctx) => {
      const rawMessage = args.trim();
      if (!rawMessage) {
        ctx.ui.notify(
          "🛡️ Usage: /defender:report-issue <description>\n" +
          "   Describe your bug or feature request. The AI will analyze it,\n" +
          "   detect type (bug/feature request), enhance the description, and create the issue.\n" +
          "   Example: /defender:report-issue The strict mode prompt doesn't show on WSL",
          "warning",
        );
        return;
      }

      const loaded = getLoadedConfig(ctx.cwd);
      const config = loaded.config;

      // Build diagnostics table
      const diagLines: string[] = [];
      diagLines.push("## Diagnostics");
      diagLines.push("");
      diagLines.push(`- **Version**: ${DEFENDER_VERSION}`);
      diagLines.push(`- **Strict Mode**: ${strictMode ? "ON" : "OFF"}${defenderDisabled ? " (but defender is DISABLED)" : ""}`);
      diagLines.push(`- **Aborted state**: ${aborted ? "yes" : "no"}`);
      diagLines.push(`- **Session stats**: ${stats.allowed} allowed, ${stats.blocked} blocked, ${stats.strictApproved} strict-approved, ${stats.strictBlocked} strict-denied, ${stats.strictApprovedAll} approve-all`);
      diagLines.push(`- **Session-approved patterns**: ${sessionApprovedPatterns.length}`);
      diagLines.push("");
      diagLines.push("### Config sources");
      diagLines.push("");
      diagLines.push("| Source | Pat | Zero | ROnly | NDel | Wlst |");
      diagLines.push("|--------|-----|------|-------|------|------|");
      for (const src of loaded.sources) {
        if (src.found) {
          diagLines.push(`| \`${src.displayPath}\` | ${src.patternCount} | ${src.zeroAccessCount} | ${src.readOnlyCount} | ${src.noDeleteCount} | ${src.whitelistCount} |`);
        } else {
          diagLines.push(`| \`${src.displayPath}\` | — | — | — | — | — |`);
        }
      }
      diagLines.push(`| **TOTAL (merged)** | ${config.bashToolPatterns.length} | ${config.zeroAccessPaths.length} | ${config.readOnlyPaths.length} | ${config.noDeletePaths.length} | ${config.strictModeWhiteList.length} |`);
      const diagnosticsMd = diagLines.join("\n");

      // Delegate to the AI agent via a follow-up message.
      // The AI will use the pi_defender_create_issue tool (GitHub REST API, no gh CLI needed).
      pi.sendUserMessage(
        `The user reported an issue for Pi Defender (Serhioromano/pi-defender).\n\n` +
        `User's message:\n"""\n${rawMessage}\n"""\n\n` +
        `Your task:\n` +
        `1. Analyze the message — is this a **bug report** or **feature request**?\n` +
        `2. Create a concise, descriptive issue title (max 80 chars)\n` +
        `3. Enhance the description: add clarity, context, steps to reproduce (for bugs) or use case (for features). Keep it in the user's voice — don't add meta-commentary about what you did.\n` +
        `4. Combine your enhanced description with the diagnostics section below into one markdown body.\n` +
        `5. Call the **pi_defender_create_issue** tool with title, body, and label ("bug" or "enhancement").\n` +
        `6. STOP. Do NOT fix the issue. Do NOT edit any source files. Do NOT update CHANGELOG.md, README.md, or AGENTS.md. The user will handle the fix separately. Your ONLY job is to create the issue.\n\n` +
        `Diagnostics to append to the issue body:\n\n${diagnosticsMd}`,
        { deliverAs: "followUp" },
      );

      ctx.ui.notify(
        "🛡️ Queued for AI analysis — the agent will analyze your report, enhance it, and create the issue.\n" +
        "   Diagnostics (version, stats, config) will be included automatically.",
        "info",
      );
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
            `🛡️🔒 ${fg("warning", "Strict Mode")} ACTIVATED (default) — ALL bash commands now require your approval\n` +
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
            `🛡️ ${fg("warning", "Strict Mode")} DEACTIVATED — normal protection restored (patterns.yaml rules only). Use /defender:strict on to re-enable.`,
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
            `🛡️ ${fg("warning", "Strict Mode")} DEACTIVATED — normal protection restored (patterns.yaml rules only). Use /defender:strict on to re-enable.`,
            "info",
          );
        } else {
          // Turning ON
          strictMode = true;
          defenderDisabled = false;
          sessionApprovedPatterns.length = 0;
          aborted = false;
          ctx.ui.notify(
            `🛡️🔒 ${fg("warning", "Strict Mode")} ACTIVATED (default) — ALL bash commands now require your approval\n` +
            "   • Select ✅ Approve / ⚠️ Deny / ⭐ Approve All / 📋 Whitelist / ❌ Abort\n" +
            "   • patterns.yaml blocked rules are ALWAYS enforced\n" +
            "   • /defender:strict off to disable",
            "info",
          );
        }
      }
    },
  });

  pi.registerCommand("defender:default-mode", {
    description: "Set or reset the default protection mode (skip session-start selector)",
    handler: async (args, ctx) => {
      const loaded = getLoadedConfig(ctx.cwd);
      const trimmedArgs = args.trim();

      // No arguments — launch the protection-level selector (same as session startup)
      if (!trimmedArgs) {
        if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
          ctx.ui.notify(
            "🛡️ No interactive UI available.\n\n" +
            "Use /defender:default-mode strict|patterns|off|interactive [--local] to set mode directly.\n\n" +
            "Current: " + (loaded.config.defaultMode && loaded.config.defaultMode !== "interactive"
              ? loaded.config.defaultMode
              : "not set (selector shown each session)"),
            "warning",
          );
          return;
        }

        const selected = await showModeSelector(ctx, " Set default protection mode:");

        if (!selected) {
          ctx.ui.notify("🛡️ Selector cancelled or unavailable.", "info");
          return;
        }

        const { mode: modeSelected, saveLocal, saveGlobal } = selected;

        // Always save the chosen mode (this IS the default-mode command).
        // If no save checkbox was ticked, default to saving globally.
        const doSaveLocal = saveLocal;
        const doSaveGlobal = saveGlobal || !saveLocal;

        const saveResults: string[] = [];
        if (doSaveLocal) {
          const r = setDefaultMode(ctx.cwd, modeSelected, false);
          saveResults.push(r.success ? "local" : r.reason ?? "local-failed");
        }
        if (doSaveGlobal) {
          const r = setDefaultMode(ctx.cwd, modeSelected, true);
          saveResults.push(r.success ? "global" : r.reason ?? "global-failed");
        }

        // Apply mode for this session immediately
        applyMode(modeSelected);

        // Reload config to pick up the change
        currentLoadedConfig = null;

        const displayMode = modeSelected === "strict" ? "🔒 Strict Mode" : modeSelected === "patterns" ? "🛡️ Patterns only" : "⚪ Disabled";
        const successes = saveResults.filter(r => r === "local" || r === "global");
        const failures = saveResults.filter(r => r !== "local" && r !== "global");

        if (successes.length > 0) {
          const scopeLabel = successes.length === 2
            ? "both locally and globally"
            : successes[0] === "local" ? "for this project (.pi/defender.yaml)" : "globally (~/.pi/defender.yaml)";
          ctx.ui.notify(`💾 Default mode set to ${displayMode} ${scopeLabel}. The selector will be skipped next session.`, "info");
        }
        if (failures.length > 0) {
          ctx.ui.notify(`💾 Save error(s): ${failures.join(", ")}`, "error");
        }

        ctx.ui.notify(
          formatConfigTable(getLoadedConfig(ctx.cwd), DEFENDER_VERSION, strictMode, defenderDisabled, getFg(), getDimAnsi()),
          "info",
        );
        return;
      }

      // Parse arguments: "strict --local" or "patterns" etc.
      const parts = trimmedArgs.split(/\s+/);
      const rawMode = parts[0].toLowerCase();
      const isLocal = parts.includes("--local");

      // Validate mode
      if (!["strict", "patterns", "off", "interactive"].includes(rawMode)) {
        ctx.ui.notify(
          `🛡️ Unknown mode: "${rawMode}". Valid modes: strict, patterns, off, interactive.\n\n` +
          "Use /defender:default-mode (no args) for usage.",
          "warning",
        );
        return;
      }

      const mode: Config["defaultMode"] = rawMode as Config["defaultMode"];
      const scopeLabel = isLocal ? "for this project (.pi/defender.yaml)" : "globally (~/.pi/defender.yaml)";

      // Set the defaultMode
      const saveResult = setDefaultMode(ctx.cwd, mode, !isLocal);
      if (saveResult.success) {
        // Reload config to pick up the change
        currentLoadedConfig = null;

        if (mode === "interactive") {
          ctx.ui.notify(
            `🛡️ Default mode reset to interactive. The session-start selector will be shown again.`,
            "info",
          );
        } else {
          const icon = mode === "strict" ? "🔒" : mode === "patterns" ? "🛡️" : "⚪";
          const label = mode === "strict" ? "Strict ON" : mode === "patterns" ? "Patterns only" : "Disabled";
          ctx.ui.notify(
            `💾 Default mode set to ${icon} ${label} ${scopeLabel}. The selector will be skipped next session.`,
            "info",
          );
        }
      } else {
        ctx.ui.notify(`💾 Failed to save: ${saveResult.reason}`, "error");
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
