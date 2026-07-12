import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// =============================================================================
// TYPES
// =============================================================================

export interface BashPattern {
  pattern: string;
  reason: string;
}

export interface Config {
  bashToolPatterns: BashPattern[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
  noDeletePaths: string[];
  strictModeWhiteList: string[];
  defaultMode?: "strict" | "patterns" | "off" | "interactive";
}

/** Per-file source tracking — what each patterns.yaml contributed. */
export interface FileSource {
  displayPath: string;
  found: boolean;
  patternCount: number;
  zeroAccessCount: number;
  readOnlyCount: number;
  noDeleteCount: number;
  whitelistCount: number;
}

/** Merged config + per-file sources for display. */
export interface LoadedConfig {
  config: Config;
  sources: FileSource[];
}

// =============================================================================
// PATTERN TUPLES — [regex_template, operation_description]
// =============================================================================

export type PatternTuple = [string, string];

export const WRITE_PATTERNS: PatternTuple[] = [
  [">\\s*{path}", "write"],
  ["\\btee\\s+(?!.*-a).*{path}", "write"],
];

export const APPEND_PATTERNS: PatternTuple[] = [
  [">>\\s*{path}", "append"],
  ["\\btee\\s+-a\\s+.*{path}", "append"],
  ["\\btee\\s+.*-a.*{path}", "append"],
];

export const EDIT_PATTERNS: PatternTuple[] = [
  ["\\bsed\\s+-i.*{path}", "edit"],
  ["\\bperl\\s+-[^\\s]*i.*{path}", "edit"],
  ["\\bawk\\s+-i\\s+inplace.*{path}", "edit"],
];

export const MOVE_COPY_PATTERNS: PatternTuple[] = [
  ["\\bmv\\s+.*\\s+{path}", "move"],
  ["\\bcp\\s+.*\\s+{path}", "copy"],
];

export const DELETE_PATTERNS: PatternTuple[] = [
  ["\\brm\\s+.*{path}", "delete"],
  ["\\bunlink\\s+.*{path}", "delete"],
  ["\\brmdir\\s+.*{path}", "delete"],
  ["\\bshred\\s+.*{path}", "delete"],
];

export const PERMISSION_PATTERNS: PatternTuple[] = [
  ["\\bchmod\\s+.*{path}", "chmod"],
  ["\\bchown\\s+.*{path}", "chown"],
  ["\\bchgrp\\s+.*{path}", "chgrp"],
];

export const TRUNCATE_PATTERNS: PatternTuple[] = [
  ["\\btruncate\\s+.*{path}", "truncate"],
  [":\\s*>\\s*{path}", "truncate"],
];

// Combined patterns for read-only paths (block ALL modifications)
export const READ_ONLY_BLOCKED: PatternTuple[] = [
  ...WRITE_PATTERNS,
  ...APPEND_PATTERNS,
  ...EDIT_PATTERNS,
  ...MOVE_COPY_PATTERNS,
  ...DELETE_PATTERNS,
  ...PERMISSION_PATTERNS,
  ...TRUNCATE_PATTERNS,
];

// Patterns for no-delete paths (block ONLY delete operations)
export const NO_DELETE_BLOCKED: PatternTuple[] = DELETE_PATTERNS;

// =============================================================================
// CONFIGURATION LOADING
// =============================================================================

function getConfigPaths(cwd: string): string[] {
  return [
    // 1. Project-local essential rules (shipped, overwritten on install)
    join(cwd, ".pi", "patterns.yaml"),
    // 2. Global essential rules (shipped, overwritten on install)
    join(homedir(), ".pi", "patterns.yaml"),
    // 3. Project-local user rules (never overwritten)
    join(cwd, ".pi", "defender.yaml"),
    // 4. Global user rules (never overwritten)
    join(homedir(), ".pi", "defender.yaml"),
  ];
}

/** Human-friendly label for a config file path. */
function displayPathFor(configPath: string, cwd: string): string {
  const localPatterns = join(cwd, ".pi", "patterns.yaml");
  const globalPatterns = join(homedir(), ".pi", "patterns.yaml");
  const localDefender = join(cwd, ".pi", "defender.yaml");
  const globalDefender = join(homedir(), ".pi", "defender.yaml");
  if (configPath === localPatterns) return ".pi/patterns.yaml";
  if (configPath === globalPatterns) return "~/.pi/patterns.yaml";
  if (configPath === localDefender) return ".pi/defender.yaml";
  if (configPath === globalDefender) return "~/.pi/defender.yaml";
  return configPath; // fallback
}

/** Empty config sentinel. */
function emptyConfig(): Config {
  return { bashToolPatterns: [], zeroAccessPaths: [], readOnlyPaths: [], noDeletePaths: [], strictModeWhiteList: [], defaultMode: undefined };
}

function parseConfigFile(path: string): Config | null {
  try {
    const content = readFileSync(path, "utf-8");
    const raw = parseYaml(content) as Record<string, unknown>;
    return {
      bashToolPatterns: (raw.bashToolPatterns as BashPattern[]) || [],
      zeroAccessPaths: (raw.zeroAccessPaths as string[]) || [],
      readOnlyPaths: (raw.readOnlyPaths as string[]) || [],
      noDeletePaths: (raw.noDeletePaths as string[]) || [],
      strictModeWhiteList: (raw.strictModeWhiteList as string[]) || [],
      defaultMode: (raw.defaultMode as Config["defaultMode"]) || undefined,
    };
  } catch {
    return null;
  }
}

function mergeConfigs(...configs: Config[]): Config {
  return {
    bashToolPatterns: configs.flatMap(c => c.bashToolPatterns),
    zeroAccessPaths: configs.flatMap(c => c.zeroAccessPaths),
    readOnlyPaths: configs.flatMap(c => c.readOnlyPaths),
    noDeletePaths: configs.flatMap(c => c.noDeletePaths),
    strictModeWhiteList: configs.flatMap(c => c.strictModeWhiteList),
    // defaultMode uses FIRST-wins (not last-wins) so project-local .pi/defender.yaml
    // always overrides global ~/.pi/defender.yaml. getConfigPaths loads local before
    // global, so the first non-undefined value is the most specific (local) one.
    defaultMode: (() => { const raw = configs.map(c => c.defaultMode).filter(Boolean); return raw.length > 0 ? raw[0] : undefined; })(),
  };
}

export function loadConfig(cwd: string): LoadedConfig {
  const configPaths = getConfigPaths(cwd);
  const configs: Config[] = [];
  const fileSources: FileSource[] = [];

  for (const configPath of configPaths) {
    const found = existsSync(configPath);
    let cfg: Config | null = null;

    if (found) {
      cfg = parseConfigFile(configPath);
      if (cfg) configs.push(cfg);
    }

    const safe = cfg ?? emptyConfig();
    fileSources.push({
      displayPath: displayPathFor(configPath, cwd),
      found: found && cfg !== null,
      patternCount: safe.bashToolPatterns.length,
      zeroAccessCount: safe.zeroAccessPaths.length,
      readOnlyCount: safe.readOnlyPaths.length,
      noDeleteCount: safe.noDeletePaths.length,
      whitelistCount: safe.strictModeWhiteList.length,
    });
  }

  const merged = configs.length > 0 ? mergeConfigs(...configs) : emptyConfig();

  return { config: merged, sources: fileSources };
}

// =============================================================================
// GLOB MATCHING
// =============================================================================

export function isGlobPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

export function globToRegex(globPattern: string): string {
  let result = "";
  for (const char of globPattern) {
    switch (char) {
      case "*":
        result += "[^\\s/]*";
        break;
      case "?":
        result += "[^\\s/]";
        break;
      case ".":
      case "\\":
      case "^":
      case "$":
      case "+":
      case "{":
      case "}":
      case "[":
      case "]":
      case "|":
      case "(":
      case ")":
        result += "\\" + char;
        break;
      default:
        result += char;
    }
  }
  return result;
}

export function matchPath(filePath: string, pattern: string): boolean {
  const expandedPattern = pattern.replace(/^~/, homedir());
  const normalized = filePath.replace(/\\/g, "/");
  const expandedNormalized = normalized.replace(/^~/, homedir());

  if (isGlobPattern(pattern)) {
    const basename = expandedNormalized.split("/").pop() || expandedNormalized;
    const basenameLower = basename.toLowerCase();
    const patternLower = pattern.toLowerCase();
    const expandedPatternLower = expandedPattern.toLowerCase();

    // Match basename against glob
    if (fnmatch(basenameLower, expandedPatternLower)) return true;
    if (fnmatch(basenameLower, patternLower)) return true;
    // Match full path against glob
    if (fnmatch(expandedNormalized.toLowerCase(), expandedPatternLower)) return true;
    return false;
  }

  // Prefix matching for directories
  const normalizedPattern = expandedPattern.replace(/\/$/, "");
  if (expandedNormalized.startsWith(normalizedPattern + "/") || expandedNormalized === normalizedPattern) {
    return true;
  }
  return false;
}

function fnmatch(name: string, pattern: string): boolean {
  const re = globToRegex(pattern);
  try {
    return new RegExp(`^${re}$`, "i").test(name);
  } catch {
    return false;
  }
}

// =============================================================================
// PATH PATTERN CHECKING (for Bash commands)
// =============================================================================

export interface CheckResult {
  blocked: boolean;
  reason: string;
}

export function checkPathPatterns(
  command: string,
  path: string,
  patterns: PatternTuple[],
  pathType: string
): { blocked: boolean; reason: string } {
  if (isGlobPattern(path)) {
    const globRegex = globToRegex(path);
    for (const [patternTemplate, operation] of patterns) {
      try {
        const cmdPrefix = patternTemplate.replace("{path}", "");
        if (cmdPrefix) {
          const regex = new RegExp(cmdPrefix + globRegex, "i");
          if (regex.test(command)) {
            return {
              blocked: true,
              reason: `Blocked: ${operation} operation on ${pathType} ${path}`,
            };
          }
        }
      } catch {
        continue;
      }
    }
  } else {
    const expanded = path.replace(/^~/, homedir());
    const escapedExpanded = expanded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedOriginal = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    for (const [patternTemplate, operation] of patterns) {
      const patternExpanded = patternTemplate.replace("{path}", escapedExpanded);
      const patternOriginal = patternTemplate.replace("{path}", escapedOriginal);
      try {
        const regexExpanded = new RegExp(patternExpanded);
        const regexOriginal = new RegExp(patternOriginal);
        if (regexExpanded.test(command) || regexOriginal.test(command)) {
          return {
            blocked: true,
            reason: `Blocked: ${operation} operation on ${pathType} ${path}`,
          };
        }
      } catch {
        continue;
      }
    }
  }

  return { blocked: false, reason: "" };
}

// =============================================================================
// BASH COMMAND CHECKING
// =============================================================================

export function checkCommand(command: string, config: Config): CheckResult {
  // Strip comment lines for pattern matching — #-prefixed lines are shell
  // comments and shouldn't affect whether the actual command matches a pattern.
  const matchTarget = stripCommentLines(command);

  // 1. Check against patterns from YAML (may block or ask)
  for (const { pattern, reason } of config.bashToolPatterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(matchTarget)) {
        return { blocked: true,  reason: `Blocked: ${reason}` };
      }
    } catch {
      continue;
    }
  }

  // 2. Check for ANY access to zero-access paths (including reads)
  for (const zeroPath of config.zeroAccessPaths) {
    if (isGlobPattern(zeroPath)) {
      const globRegex = globToRegex(zeroPath);
      try {
        const regex = new RegExp(globRegex, "i");
        if (regex.test(matchTarget)) {
          return {
            blocked: true,
            reason: `Blocked: zero-access pattern ${zeroPath} (no operations allowed)`,
          };
        }
      } catch {
        continue;
      }
    } else {
      const expanded = zeroPath.replace(/^~/, homedir());
      if (matchTarget.includes(expanded) || matchTarget.includes(zeroPath)) {
        return {
          blocked: true,
          reason: `Blocked: zero-access path ${zeroPath} (no operations allowed)`,
        };
      }
    }
  }

  // 3. Check for modifications to read-only paths (reads allowed)
  for (const readonlyPath of config.readOnlyPaths) {
    const result = checkPathPatterns(matchTarget, readonlyPath, READ_ONLY_BLOCKED, "read-only path");
    if (result.blocked) {
      return { ...result};
    }
  }

  // 4. Check for deletions on no-delete paths (read/write/edit allowed)
  for (const noDeletePath of config.noDeletePaths) {
    const result = checkPathPatterns(matchTarget, noDeletePath, NO_DELETE_BLOCKED, "no-delete path");
    if (result.blocked) {
      return { ...result};
    }
  }

  return { blocked: false,  reason: "" };
}

// =============================================================================
// COMMENT LINE STRIPPING
// =============================================================================

/**
 * Strip shell comment lines (lines starting with # after optional whitespace)
 * from a bash command string. Inline comments (where # appears after a command
 * on the same line) are preserved because they don't affect pattern matching.
 *
 * Only whole-line comments are removed — a line that starts with # (possibly
 * indented) is dropped entirely. Lines with # mid-line are kept as-is.
 *
 * Examples:
 *   "# comment\nls -la"              → "ls -la"
 *   "  # comment\n  ls -la"          → "ls -la"
 *   "ls -la # inline comment"         → "ls -la # inline comment" (unchanged)
 *   "# line1\n# line2\nssh root@..." → "ssh root@..."
 */
export function stripCommentLines(command: string): string {
  const lines = command.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    // Only strip if the ENTIRE line is a comment (starts with #)
    if (!trimmed.startsWith("#")) {
      result.push(line);
    }
  }

  return result.join("\n").trim();
}

// =============================================================================
// CHAIN COMMAND SPLITTING
// =============================================================================

/**
 * Split a bash command string into individual commands by chain separators.
 * Each sub-command has shell comment lines stripped before being returned.
 * Recognized separators: &&, ||, ;
 * Pipes (|) are NOT treated as chain separators — they form a single pipeline.
 *
 * Shell-aware: string literals (single-quoted, double-quoted, backtick-quoted)
 * are tracked and chain separators inside them are NOT split on.
 * Escaped separators (\;, \&&, \||) are also preserved as literal content.
 *
 * Examples:
 *   "git add . && git commit -m 'msg'"  → ["git add .", "git commit -m 'msg'"]
 *   "cd /tmp; rm -rf *"               → ["cd /tmp", "rm -rf *"]
 *   "echo 'a;b' && echo done"          → ["echo 'a;b'", "echo done"]
 *   "bun -e \"code; more\" && ls"       → ["bun -e \"code; more\"", "ls"]
 *   "echo foo\\;bar"                    → ["echo foo\\;bar"]
 *   "ls -la"                            → ["ls -la"]
 */
export function splitChainCommands(command: string): string[] {
  const result: string[] = [];
  let current = "";
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // === Track string literals: skip everything inside until closing quote ===
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      current += ch;
      i++;

      while (i < command.length) {
        const inner = command[i];
        if (inner === "\\") {
          // Backslash escape — consume both the backslash and the next char
          current += inner;
          i++;
          if (i < command.length) {
            current += command[i];
            i++;
          }
          continue;
        }
        if (inner === quote) {
          // Closing quote found
          current += inner;
          i++;
          break;
        }
        // Regular character inside string — keep it
        current += inner;
        i++;
      }
      continue;
    }

    // === Handle escaped chain separators: \;, \&&, \|| ===
    // === Handle bash line continuation: \<newline> ===
    if (ch === "\\") {
      const next = i + 1 < command.length ? command[i + 1] : "";
      if (next === ";" || next === "&" || next === "|") {
        // Literal escaped separator — keep both chars
        current += ch + next;
        i += 2;
        continue;
      }
      // Bash line continuation: \ followed by \n — consume silently
      if (next === "\n") {
        i += 2;
        continue;
      }
      // Windows line ending: \ followed by \r\n — consume silently
      if (next === "\r" && i + 2 < command.length && command[i + 2] === "\n") {
        i += 3;
        continue;
      }
      // Other escape — keep as-is
      current += ch;
      i++;
      if (i < command.length) {
        current += command[i];
        i++;
      }
      continue;
    }

    // === Check for chain separator: && ===
    if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
      const trimmed = current.trim();
      if (trimmed.length > 0) result.push(stripCommentLines(trimmed));
      current = "";
      i += 2;
      continue;
    }

    // === Check for chain separator: || ===
    if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
      const trimmed = current.trim();
      if (trimmed.length > 0) result.push(stripCommentLines(trimmed));
      current = "";
      i += 2;
      continue;
    }

    // === Check for chain separator: ; ===
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) result.push(stripCommentLines(trimmed));
      current = "";
      i++;
      continue;
    }

    // === Regular character ===
    current += ch;
    i++;
  }

  // Push remaining text
  const trimmed = current.trim();
  if (trimmed.length > 0) result.push(stripCommentLines(trimmed));

  // Filter out any sub-commands that became empty after stripping comments
  return result.filter(cmd => cmd.length > 0);
}

// =============================================================================
// WHITELIST CHECKING — strict mode auto-approve
// =============================================================================

/**
 * Check if ALL sub-commands in a (possibly chained) command are whitelisted.
 * For a chain like "git add . && git commit -m 'msg'", BOTH sub-commands
 * must individually match a whitelist pattern for the whole chain to pass.
 *
 * Shell comment lines (#-prefixed) are stripped from each sub-command
 * before matching, so commands like "# comment\nssh root@..." match
 * whitelist patterns written for the actual command.
 *
 * Returns the matching pattern for single commands, or a summary for chains.
 */
export function checkWhitelist(command: string, config: Config): { matched: boolean; pattern: string } {
  const subCommands = splitChainCommands(command);

  if (subCommands.length === 0) return { matched: false, pattern: "" };

  // For each sub-command, at least one whitelist pattern must match
  const unmatched: string[] = [];
  const matchedPatterns: string[] = [];

  for (const sub of subCommands) {
    // Strip comment lines before matching — ensures patterns like ^ssh\b
    // match commands prefixed with # comment lines.
    const matchTarget = stripCommentLines(sub);
    let subMatched = false;
    for (const pattern of config.strictModeWhiteList) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(matchTarget)) {
          subMatched = true;
          matchedPatterns.push(pattern);
          break;
        }
      } catch {
        continue;
      }
    }
    if (!subMatched) {
      unmatched.push(sub);
    }
  }

  if (unmatched.length > 0) {
    return { matched: false, pattern: "" };
  }

  // All matched — return a summary (or first match for single commands)
  if (subCommands.length === 1) {
    return { matched: true, pattern: matchedPatterns[0] || "" };
  }
  return { matched: true, pattern: `chain of ${subCommands.length} sub-commands — all whitelisted` };
}

// =============================================================================
// TOKENIZER — split bash command into tokens respecting quotes
// =============================================================================

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < command.length) {
    // Skip whitespace
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i >= command.length) break;

    let token = "";
    if (command[i] === '"' || command[i] === "'") {
      const quote = command[i];
      i++; // skip opening quote
      while (i < command.length && command[i] !== quote) {
        if (command[i] === "\\") i++; // skip escaped char
        token += command[i];
        i++;
      }
      i++; // skip closing quote
    } else {
      while (i < command.length && !/\s/.test(command[i])) {
        if (command[i] === "\\") i++; // skip escaped char
        token += command[i];
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * Extract just the command name from a full path.
 * "/usr/bin/find" → "find", "find" → "find"
 */
function getCommandName(token: string): string {
  const parts = token.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || token;
}

// Meta-commands: tools whose first argument is a subcommand that defines what they do
const META_COMMANDS = new Set([
  "git", "npm", "npx", "yarn", "pnpm", "bun",
  "docker", "docker-compose", "kubectl", "helm",
  "pip", "pip3", "cargo", "go", "rustup",
  "systemctl", "journalctl", "pm2", "make",
]);

// Commands with a `run` sub-command whose script name should be captured too.
// npm run build  →  ^npm run build\b  (not just ^npm run\b)
// bun run dev    →  ^bun run dev\b
const RUN_COMMANDS = new Set(["npm", "yarn", "pnpm", "bun"]);

/**
 * Generate a whitelist regex pattern from a single bash command.
 * Extracts only the tool identity — base command plus subcommand (for meta-tools)
 * — and wraps in ^...\b. Strips all flags, parameters, paths, and directories.
 *
 * For run-commands (npm, yarn, pnpm, bun) the script name is also captured,
 * with a flag-tolerant gap to allow flags like --if-present, -s, --watch:
 *   "npm run build"         →  "^npm run(\\s+--?[a-zA-Z][\\w-]*)*\\s+build\\b"
 *   "npm run --if-present build" → "^npm run(\\s+--?[a-zA-Z][\\w-]*)*\\s+build\\b"
 *   "npm run -s build"      →  "^npm run(\\s+--?[a-zA-Z][\\w-]*)*\\s+build\\b"
 *
 * Examples:
 *   "find . -name '*.ts'"   → "^find\\b"
 *   "git diff HEAD~1"       → "^git diff\\b"
 *   "npx tsc --noEmit"      → "^npx tsc\\b"
 *   "npm run build"         → "^npm run(\\s+--?[a-zA-Z][\\w-]*)*\\s+build\\b"
 *   "npm run --if-present build" → "^npm run(\\s+--?[a-zA-Z][\\w-]*)*\\s+build\\b"
 *   "npm run"               → "" (no fallback — ^npm run\b would match ALL run commands)
 *   "bun run"               → ""
 *   "bun run dev"           → "^bun run(\\s+--?[a-zA-Z][\\w-]*)*\\s+dev\\b"
 *   "npm install"           → "^npm install\\b"
 *   "grep -n 'pat' file"    → "^grep\\b"
 *   "ls -la /tmp"           → "^ls\\b"
 *   "/usr/bin/curl url"     → "^curl\\b"
 */
export function generateWhitelistPattern(command: string): string {
  const tokens = tokenize(command.trim());
  if (tokens.length === 0) return "";

  const identity: string[] = [];

  // First token is always the base command (strip path prefix if present)
  const baseCmd = getCommandName(tokens[0]);
  identity.push(baseCmd);

  // For meta-commands, include the subcommand if it's not a flag
  if (META_COMMANDS.has(baseCmd) && tokens.length > 1) {
    const sub = tokens[1];
    if (!sub.startsWith("-")) {
      identity.push(sub);

      // For run-commands (npm, yarn, pnpm, bun), capture the script name too.
      // Scan past flags (--if-present, -s, --watch, etc.) to find the script.
      // npm run --if-present build → ^npm run(\s+--?[a-zA-Z][\w-]*)*\s+build\b
      //
      // IMPORTANT: never generate ^npm run\b as a fallback — it would
      // auto-approve ALL run commands, defeating the purpose.
      if (RUN_COMMANDS.has(baseCmd) && sub === "run") {
        // Find the first non-flag token after "run" — that's the script name
        let scriptIdx = -1;
        for (let i = 2; i < tokens.length; i++) {
          if (!tokens[i].startsWith("-")) {
            scriptIdx = i;
            break;
          }
        }
        if (scriptIdx !== -1) {
          const script = tokens[scriptIdx];
          const escapedBase = baseCmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const escapedScript = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return `^${escapedBase} run(\\s+--?[a-zA-Z][\\w-]*)*\\s+${escapedScript}\\b`;
        }
        // No script name found — return empty to prevent generating
        // ^npm run\b which would match all run commands.
        return "";
      }
    }
  }

  const raw = identity.join(" ");
  // Escape regex special chars, preserving the literal command as a pattern
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped}\\b`;
}

/**
 * Generate whitelist patterns for each sub-command in a (possibly chained) command.
 * Splits on &&, ||, ; and generates a regex pattern for each individual command.
 *
 * Example:
 *   "git diff HEAD~1 && npm run build"
 *   → ["^git diff\\b", "^npm run(\\s+--?[a-zA-Z][\\w-]*)*\\s+build\\b"]
 */
export function generateWhitelistPatterns(command: string): string[] {
  return splitChainCommands(command)
    .map(cmd => generateWhitelistPattern(cmd))
    .filter(p => p.length > 0);
}

/**
 * Add a single pattern to the strictModeWhiteList in the project's .pi/defender.yaml.
 * Creates the file and directory if they don't exist.
 * Does NOT duplicate existing patterns.
 */
export function addPatternToWhitelist(cwd: string, pattern: string): { added: boolean; reason: string } {
  const result = addPatternsToWhitelist(cwd, [pattern]);
  return { added: result.added > 0, reason: result.reason };
}

/**
 * Add multiple patterns to the strictModeWhiteList in the project's .pi/defender.yaml.
 * Skips duplicates — only truly new patterns are counted as "added".
 * Creates the file and directory if they don't exist.
 */
export function addPatternsToWhitelist(cwd: string, patterns: string[]): { added: number; skipped: number; reason: string } {
  const piDir = join(cwd, ".pi");
  const defenderPath = join(piDir, "defender.yaml");

  // Create .pi directory if needed
  if (!existsSync(piDir)) {
    try {
      mkdirSync(piDir, { recursive: true });
    } catch {
      return { added: 0, skipped: 0, reason: `Failed to create directory: ${piDir}` };
    }
  }

  // Read or initialize the file
  let raw: Record<string, unknown>;
  if (existsSync(defenderPath)) {
    try {
      const content = readFileSync(defenderPath, "utf-8");
      raw = parseYaml(content) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  } else {
    raw = {};
  }

  // Ensure strictModeWhiteList exists
  const existingList: string[] = (raw.strictModeWhiteList as string[]) || [];

  let added = 0;
  let skipped = 0;

  for (const pattern of patterns) {
    if (existingList.includes(pattern)) {
      skipped++;
    } else {
      existingList.push(pattern);
      added++;
    }
  }

  if (added === 0) {
    return { added: 0, skipped, reason: `All ${patterns.length} pattern(s) already in whitelist` };
  }

  // Write back
  raw.strictModeWhiteList = existingList;
  try {
    const yamlStr = stringifyYaml(raw, { lineWidth: 120 });
    writeFileSync(defenderPath, yamlStr, "utf-8");
    return { added, skipped, reason: "" };
  } catch (e) {
    return { added: 0, skipped: 0, reason: `Failed to write patterns: ${String(e)}` };
  }
}

// =============================================================================
// GLOBALIZE WHITELIST — copy local patterns to global defender.yaml
// =============================================================================

/**
 * Read only the strictModeWhiteList from a specific defender.yaml path.
 * Returns empty array if file doesn't exist or can't be parsed.
 */
function readWhitelistFromFile(defenderPath: string): string[] {
  const cfg = parseConfigFile(defenderPath);
  return cfg?.strictModeWhiteList || [];
}

/**
 * Add patterns to the strictModeWhiteList in a specific defender.yaml.
 * Creates the file and directory if they don't exist.
 * Preserves all other existing keys in the YAML file.
 * Skips duplicates — only truly new patterns are counted.
 */
function addPatternsToDefenderFile(
  defenderPath: string,
  patterns: string[],
): { added: number; skipped: number; reason: string } {
  const defenderDir = dirname(defenderPath);

  if (!existsSync(defenderDir)) {
    try {
      mkdirSync(defenderDir, { recursive: true });
    } catch {
      return { added: 0, skipped: 0, reason: `Failed to create directory: ${defenderDir}` };
    }
  }

  let raw: Record<string, unknown>;
  if (existsSync(defenderPath)) {
    try {
      const content = readFileSync(defenderPath, "utf-8");
      raw = parseYaml(content) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  } else {
    raw = {};
  }

  const existingList: string[] = (raw.strictModeWhiteList as string[]) || [];
  let added = 0;
  let skipped = 0;

  for (const pattern of patterns) {
    if (existingList.includes(pattern)) {
      skipped++;
    } else {
      existingList.push(pattern);
      added++;
    }
  }

  if (added === 0) {
    return { added: 0, skipped, reason: `All ${patterns.length} pattern(s) already in whitelist` };
  }

  raw.strictModeWhiteList = existingList;
  try {
    const yamlStr = stringifyYaml(raw, { lineWidth: 120 });
    writeFileSync(defenderPath, yamlStr, "utf-8");
    return { added, skipped, reason: "" };
  } catch (e) {
    return { added: 0, skipped: 0, reason: `Failed to write patterns: ${String(e)}` };
  }
}

/**
 * Compare local (.pi/defender.yaml) and global (~/.pi/defender.yaml) whitelists.
 * Copy any patterns from local that don't exist in global to the global file.
 *
 * This lets users accumulate whitelist entries across projects and then
 * globalize them so future projects benefit from the same approvals.
 */
export function mergeWhitelistToGlobal(cwd: string): { added: number; skipped: number; reason: string } {
  const localPath = join(cwd, ".pi", "defender.yaml");
  const globalPath = join(homedir(), ".pi", "defender.yaml");

  const localWhitelist = readWhitelistFromFile(localPath);
  const globalWhitelist = readWhitelistFromFile(globalPath);

  // Find patterns in local that are NOT in global
  const newPatterns = localWhitelist.filter(p => !globalWhitelist.includes(p));

  if (newPatterns.length === 0) {
    return {
      added: 0,
      skipped: 0,
      reason: "No new patterns to globalize — local whitelist is empty or all patterns already exist in global",
    };
  }

  return addPatternsToDefenderFile(globalPath, newPatterns);
}

// =============================================================================
// TABLE FORMATTING — session-start notification
// =============================================================================

function padR(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + " ".repeat(len - s.length);
}

function padL(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return " ".repeat(len - s.length) + s;
}

const COL_SRC = 24;
const COL_PAT = 4;
const COL_ZERO = 5;
const COL_RO = 6;
const COL_ND = 5;
const COL_WL = 5;

/**
 * Color a padded number column with accent if non-zero.
 * After the accent text (which ends in `\x1b[0m` reset), appends `dimAnsi`
 * to restore the ambient dim styling so remaining table text stays dim.
 */
function accentCol(
  n: number,
  colWidth: number,
  fg?: (color: string, text: string) => string,
  dimAnsi?: string,
): string {
  const padded = padL(String(n), colWidth);
  if (n !== 0 && fg) {
    return fg("accent", padded) + (dimAnsi ?? "");
  }
  return padded;
}

/**
 * Build a human-readable table showing which rules were loaded from which sources.
 * Uses Unicode box-drawing characters for a clean table look.
 *
 * Sources shown:
 *   .pi/patterns.yaml    — essential rules (shipped, overwritten on install)
 *   ~/.pi/patterns.yaml   — essential rules (shipped, overwritten on install)
 *   .pi/defender.yaml     — user rules (never overwritten)
 *   ~/.pi/defender.yaml   — user rules (never overwritten)
 *
 * @param fg      Optional theme color function — non-zero numbers are highlighted in accent.
 * @param dimAnsi Optional raw dim ANSI escape code — restored after each accent-colored cell
 *                to keep surrounding text dim instead of defaulting to bright white.
 */
export function formatConfigTable(
  loaded: LoadedConfig,
  version: string,
  strictMode: boolean,
  disabled: boolean,
  fg?: (color: string, text: string) => string,
  dimAnsi?: string,
): string {
  const lines: string[] = [];

  // Status header
  const statusIcon = disabled ? "⚪" : strictMode ? "🔒" : "🛡️";
  const statusText = disabled ? "DISABLED" : strictMode ? "Strict Mode ON" : "Patterns only";
  lines.push(`🛡️  Pi Defender v${version}  —  ${statusIcon} ${statusText}`);
  
  lines.push("");
  lines.push("To change default mode run /defender:default-mode command!");

  if (disabled) {
    return lines.join("\n");
  }

  lines.push("");
  lines.push("  Rules loaded:");

  // Inner content width: COL_SRC + 1 + COL_PAT + 1 + COL_ZERO + 1 + COL_RO + 1 + COL_ND + 1 + COL_WL = 24+1+4+1+5+1+6+1+5+1+5 = 54
  // Border: 2 outer spaces + left box char + dashes + right box char = 2 + 1 + 56 + 1 = 60
  const BORDER = "─".repeat(56);

  // Table top
  lines.push(`  ┌${BORDER}┐`);

  // Column header
  const header = [
    padR("Source", COL_SRC),
    padL("Pat", COL_PAT),
    padL("Zero", COL_ZERO),
    padL("ROnly", COL_RO),
    padL("NDel", COL_ND),
    padL("Wlst", COL_WL),
  ].join(" ");
  lines.push(`  │ ${header} │`);
  lines.push(`  ├${BORDER}┤`);

  // Source rows
  for (const src of loaded.sources) {
    if (src.found) {
      const row = [
        padR(src.displayPath, COL_SRC),
        accentCol(src.patternCount, COL_PAT, fg, dimAnsi),
        accentCol(src.zeroAccessCount, COL_ZERO, fg, dimAnsi),
        accentCol(src.readOnlyCount, COL_RO, fg, dimAnsi),
        accentCol(src.noDeleteCount, COL_ND, fg, dimAnsi),
        accentCol(src.whitelistCount, COL_WL, fg, dimAnsi),
      ].join(" ");
      lines.push(`  │ ${row} │`);
    } else {
      // " — not found —" is 14 chars; inner = 24+14+spaces = 54; need 54-24-14 = 16 spaces
      const inner = padR(src.displayPath, COL_SRC) + " — not found —" + " ".repeat(16);
      lines.push(`  │ ${inner} │`);
    }
  }

  // Total row
  lines.push(`  ├${BORDER}┤`);
  const cfg = loaded.config;
  const totalRow = [
    padR("TOTAL (merged)", COL_SRC),
    accentCol(cfg.bashToolPatterns.length, COL_PAT, fg, dimAnsi),
    accentCol(cfg.zeroAccessPaths.length, COL_ZERO, fg, dimAnsi),
    accentCol(cfg.readOnlyPaths.length, COL_RO, fg, dimAnsi),
    accentCol(cfg.noDeletePaths.length, COL_ND, fg, dimAnsi),
    accentCol(cfg.strictModeWhiteList.length, COL_WL, fg, dimAnsi),
  ].join(" ");
  lines.push(`  │ ${totalRow} │`);

  // Table bottom
  lines.push(`  └${BORDER}┘`);

  return lines.join("\n");
}

/** Snapshot of runtime counters for the stats table. */
export interface StatsSnapshot {
  allowed: number;
  blocked: number;
  asked: number;
  strictApproved: number;
  strictBlocked: number;
  strictApprovedAll: number;
}

/**
 * Build a stats table matching the style of formatConfigTable.
 * Simpler 2-column layout: Stat label + count.
 *
 * @param fg      Optional theme color function — non-zero counts are highlighted in accent.
 * @param dimAnsi Optional raw dim ANSI escape code — restored after each accent-colored cell.
 */
export function formatStatsTable(
  st: StatsSnapshot,
  sessionApprovedCount: number,
  fg?: (color: string, text: string) => string,
  dimAnsi?: string,
): string {
  const COL_LABEL = 24;
  const COL_VAL = 6;
  const BORDER = "─".repeat(33);

  const rows: [string, number][] = [
    ["Allowed", st.allowed],
    ["Blocked", st.blocked],
    ["Asked", st.asked],
    ["Strict approved", st.strictApproved],
    ["Strict denied", st.strictBlocked],
    ["Approve-all", st.strictApprovedAll],
    ["Session-approved", sessionApprovedCount],
  ];

  const lines: string[] = [];
  lines.push(`  ┌${BORDER}┐`);
  lines.push(`  │ ${padR("Stat", COL_LABEL)} ${padL("Cnt", COL_VAL)} │`);
  lines.push(`  ├${BORDER}┤`);
  for (const [label, n] of rows) {
    lines.push(`  │ ${padR(label, COL_LABEL)} ${accentCol(n, COL_VAL, fg, dimAnsi)} │`);
  }
  lines.push(`  └${BORDER}┘`);
  return lines.join("\n");
}

// =============================================================================
// PATH CHECKING for Edit/Write/Read tools
// =============================================================================

// =============================================================================
// DEFAULT MODE — persist user's session-start choice
// =============================================================================

/**
 * Write `defaultMode` to the defender.yaml file (local or global).
 * Creates the file and directory if they don't exist.
 * Uses last-wins semantics — if the file already has other keys they are preserved.
 *
 * @param cwd Current working directory (for resolving local path)
 * @param mode The defaultMode value to write
 * @param global_ If true, writes to ~/.pi/defender.yaml; otherwise .pi/defender.yaml
 */
export function setDefaultMode(
  cwd: string,
  mode: Config["defaultMode"],
  global_: boolean,
): { success: boolean; path: string; reason?: string } {
  const dir = global_ ? join(homedir(), ".pi") : join(cwd, ".pi");
  const filePath = join(dir, "defender.yaml");

  // Create directory if needed
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { success: false, path: filePath, reason: `Failed to create directory: ${dir}: ${String(e)}` };
    }
  }

  // Read or initialise the file
  let raw: Record<string, unknown>;
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(content);
      // parseYaml returns null for empty files or non-map values (scalars, arrays)
      raw = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
    } catch {
      raw = {};
    }
  } else {
    raw = {};
  }

  // Write the value
  raw.defaultMode = mode;

  try {
    // Build YAML output with defaultMode as the first key, followed by a blank line.
    // This makes it easy to spot the primary config setting at a glance.
    const { defaultMode: _, ...rest } = raw;
    const lines: string[] = [`defaultMode: ${mode}`];
    if (Object.keys(rest).length > 0) {
      lines.push(""); // blank line before the rest
      lines.push(stringifyYaml(rest, { lineWidth: 120 }));
    }
    const yamlStr = lines.join("\n") + "\n";
    writeFileSync(filePath, yamlStr, "utf-8");
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, path: filePath, reason: `Failed to write file: ${String(e)}` };
  }
}

// =============================================================================
// PATH CHECKING for Edit/Write/Read tools
// =============================================================================

export function checkFileAccess(
  filePath: string,
  config: Config,
  operation: "write" | "edit" | "read"
): { blocked: boolean; reason: string } {
  // 1. Zero-access paths — block everything
  for (const zaPath of config.zeroAccessPaths) {
    if (matchPath(filePath, zaPath)) {
      return {
        blocked: true,
        reason: `Blocked: zero-access path ${zaPath} — no operations allowed on ${filePath}`,
      };
    }
  }

  // 2. Read-only paths — block writes/edits, allow reads
  if (operation !== "read") {
    for (const roPath of config.readOnlyPaths) {
      if (matchPath(filePath, roPath)) {
        return {
          blocked: true,
          reason: `Blocked: read-only path ${roPath} — cannot ${operation} ${filePath}`,
        };
      }
    }
  }

  return { blocked: false, reason: "" };
}

// =============================================================================
// =============================================================================
// VERSION / CHANGELOG — detect upgrades and show what's new
// =============================================================================

/**
 * Find CHANGELOG.md in the package directory.
 * Tries multiple paths to handle both development (src/) and installed (dist/src/) runtimes.
 * Returns the file content or null if not found.
 */
function readChangelog(): string | null {
  // Try multiple locations — covering dev mode, installed, and ESM without __dirname.
  // @ts-ignore — __dirname is CJS global, may be injected by Pi runtime
  const dir = typeof __dirname === "string" && __dirname ? __dirname : "";
  const candidates = [
    join(dir, "..", "CHANGELOG.md"),                          // dev (src/ → project root)
    join(dir, "..", "..", "CHANGELOG.md"),                    // installed (dist/src/ → pkg root)
    join(process.cwd(), "CHANGELOG.md"),                      // cwd fallback (dev from root)
    join(process.cwd(), "node_modules", "pi-defender", "CHANGELOG.md"), // global install
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return readFileSync(p, "utf-8"); } catch { /* continue */ }
    }
  }
  return null;
}

/** Path to the version-state file — just the last-seen version string. */
function versionStatePath(): string {
  return join(homedir(), ".pi", "defender-version");
}

/**
 * Read the last-seen version from ~/.pi/defender-version.
 * Returns the version string or undefined if the file doesn't exist.
 */
export function readLastSeenVersion(): string | undefined {
  try {
    const p = versionStatePath();
    if (!existsSync(p)) return undefined;
    return readFileSync(p, "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the current version to ~/.pi/defender-version.
 * A plain text file — no YAML, no clutter.
 */
export function writeLastSeenVersion(version: string): void {
  try {
    const p = versionStatePath();
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, version + "\n", "utf-8");
  } catch { /* ignore — non-critical */ }
}

/**
 * Compare two semver strings (x.y.z).
 * Returns: negative if a < b, 0 if equal, positive if a > b.
 */
function semverCmp(a: string, b: string): number {
  const aParts = a.replace(/^v/, "").split(".").map(Number);
  const bParts = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const aNum = aParts[i] || 0;
    const bNum = bParts[i] || 0;
    if (aNum !== bNum) return aNum - bNum;
  }
  return 0;
}

/**
 * Parse CHANGELOG.md content into a Map of version string → entry text.
 * Version entries are delimited by "## [vX.Y.Z]" headers.
 */
export function parseChangelogVersions(changelog: string): Map<string, string> {
  const map = new Map<string, string>();
  const versionHeaderRegex = /^## \[v?([\d.]+)\]/;

  // Find all version header positions
  const positions: { version: string; start: number }[] = [];
  const lines = changelog.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(versionHeaderRegex);
    if (m) {
      positions.push({ version: m[1], start: i });
    }
  }

  // Extract content between headers
  for (let i = 0; i < positions.length; i++) {
    const { version, start } = positions[i];
    const end = i + 1 < positions.length
      ? positions[i + 1].start
      : lines.length;
    // Slice from start to end, trim trailing whitespace
    const entry = lines.slice(start, end).join("\n").trim();
    map.set(version, entry);
  }

  return map;
}

/**
 * Get changelog diff between the last seen version and the current version.
 *
 * Reads CHANGELOG.md from disk (bundled with the package).
 * Returns entries for versions strictly greater than lastSeenVersion and
 * up to and including currentVersion. Sorted newest-first.
 *
 * If lastSeenVersion is undefined (first run), returns only the current
 * version's entry.
 *
 * Returns null if CHANGELOG.md is not found or no new versions exist.
 */
export function getChangelogDiff(
  currentVersion: string,
  lastSeenVersion: string | undefined,
): string | null {
  const changelog = readChangelog();
  if (!changelog) return null;

  const versions = parseChangelogVersions(changelog);
  if (versions.size === 0) return null;

  // Collect relevant version entries
  const relevant: string[] = [];
  for (const [ver, entry] of versions) {
    const cmpCurrent = semverCmp(ver, currentVersion);
    if (cmpCurrent > 0) continue; // skip versions newer than current

    if (lastSeenVersion) {
      const cmpLast = semverCmp(ver, lastSeenVersion);
      if (cmpLast <= 0) continue; // skip versions already seen or older
    }

    relevant.push(entry);
  }

  // If no lastSeenVersion, only show the current version's entry
  if (!lastSeenVersion && relevant.length > 1) {
    const currentEntry = versions.get(currentVersion);
    return currentEntry || null;
  }

  if (relevant.length === 0) return null;

  return relevant.reverse().join("\n\n");
}
