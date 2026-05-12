/**
 * Pi Damage Control
 * =================
 *
 * Defense-in-depth protection for Pi coding agent.
 * Blocks dangerous commands and protects sensitive files via Pi extensions.
 *
 * Features:
 *   - Bash tool: regex patterns to block dangerous commands (rm -rf, sudo, etc.)
 *   - Bash tool: ask mode for destructive-but-valid commands (git push --force)
 *   - Edit/Write/Read tools: path-level protection (zero-access, read-only)
 *   - Bash tool: path reference detection in commands
 *   - YAML configuration (project-local or global)
 *   - Management commands: /damage-control:reload, /damage-control:status, /damage-control:patterns
 *
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
  let stats = { blocked: 0, asked: 0, allowed: 0 };

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
      `🛡️ Damage Control active (${config.bashToolPatterns.length} patterns, ${config.zeroAccessPaths.length} zero-access, ${config.readOnlyPaths.length} read-only)`,
      "info",
    );
  });

  // ===========================================================================
  // TOOL CALL INTERCEPTION — Bash
  // ===========================================================================

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    if (!command) return undefined;

    const config = getConfig(ctx.cwd);
    const result = checkCommand(command, config);

    if (result.blocked) {
      stats.blocked++;
      ctx.ui.notify(`🛡️ BLOCKED: ${result.reason}`, "error");
      return { block: true, reason: result.reason };
    }

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

  pi.registerCommand("damage-control:status", {
    description: "Show damage control statistics and active configuration",
    handler: async (_args, ctx) => {
      const config = getConfig(ctx.cwd);
      ctx.ui.notify(
        `🛡️ Damage Control Stats\n` +
        `  Allowed: ${stats.allowed} | Blocked: ${stats.blocked} | Asked: ${stats.asked}\n` +
        `  Bash patterns: ${config.bashToolPatterns.length}\n` +
        `  Zero-access paths: ${config.zeroAccessPaths.length}\n` +
        `  Read-only paths: ${config.readOnlyPaths.length}\n` +
        `  No-delete paths: ${config.noDeletePaths.length}`,
        "info",
      );
    },
  });

  pi.registerCommand("damage-control:reload", {
    description: "Reload damage control configuration from YAML",
    handler: async (_args, ctx) => {
      currentConfig = null;
      const config = getConfig(ctx.cwd);
      ctx.ui.notify(
        `🛡️ Config reloaded: ${config.bashToolPatterns.length} patterns, ${config.zeroAccessPaths.length} zero-access, ${config.readOnlyPaths.length} read-only`,
        "success",
      );
    },
  });

  pi.registerCommand("damage-control:patterns", {
    description: "Initialize project-local patterns.yaml from template",
    handler: async (_args, ctx) => {
      const dir = join(ctx.cwd, ".pi", "damage-control");
      const file = join(dir, "patterns.yaml");

      if (existsSync(file)) {
        ctx.ui.notify(`patterns.yaml already exists at ${file}`, "warning");
        return;
      }

      mkdirSync(dir, { recursive: true });
      writeFileSync(file, PATTERNS_YAML_TEMPLATE, "utf-8");
      ctx.ui.notify(`✅ Created ${file} — edit it to customize protection rules, then /damage-control:reload`, "success");
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

const PATTERNS_YAML_TEMPLATE = `# Pi Damage Control — Security Patterns
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
