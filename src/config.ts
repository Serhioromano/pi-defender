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
  const paths: string[] = [];

  paths.push(join(cwd, ".pi", "patterns.yaml"));

  // 2. Global user config (~/.pi/defender/patterns.yaml)
  paths.push(join(homedir(), ".pi", "patterns.yaml"));
  
  // 3. Bundled defaults shipped with the package
  // @ts-ignore — __dirname is CJS global
  if (typeof __dirname !== "undefined") {
    paths.push(join(__dirname, "patterns.yaml"));
  }
  paths.push(join(cwd, "src", "patterns.yaml"));
  paths.push(join(cwd, "node_modules", "pi-defender", "src", "patterns.yaml"));

  return paths;
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
  };
}

export function loadConfig(cwd: string): Config {
  const configPaths = getConfigPaths(cwd);
  const configs: Config[] = [];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      const parsed = parseConfigFile(configPath);
      if (parsed) configs.push(parsed);
    }
  }

  if (configs.length === 0) {
    return { bashToolPatterns: [], zeroAccessPaths: [], readOnlyPaths: [], noDeletePaths: [], strictModeWhiteList: [] };
  }

  return mergeConfigs(...configs);
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
  // 1. Check against patterns from YAML (may block or ask)
  for (const { pattern, reason } of config.bashToolPatterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(command)) {
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
        if (regex.test(command)) {
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
      if (command.includes(expanded) || command.includes(zeroPath)) {
        return {
          blocked: true,
          reason: `Blocked: zero-access path ${zeroPath} (no operations allowed)`,
        };
      }
    }
  }

  // 3. Check for modifications to read-only paths (reads allowed)
  for (const readonlyPath of config.readOnlyPaths) {
    const result = checkPathPatterns(command, readonlyPath, READ_ONLY_BLOCKED, "read-only path");
    if (result.blocked) {
      return { ...result};
    }
  }

  // 4. Check for deletions on no-delete paths (read/write/edit allowed)
  for (const noDeletePath of config.noDeletePaths) {
    const result = checkPathPatterns(command, noDeletePath, NO_DELETE_BLOCKED, "no-delete path");
    if (result.blocked) {
      return { ...result};
    }
  }

  return { blocked: false,  reason: "" };
}

// =============================================================================
// CHAIN COMMAND SPLITTING
// =============================================================================

const CHAIN_SEPARATOR = /\s*(?:&&|\|\||;)\s*/;

/**
 * Split a bash command string into individual commands by chain separators.
 * Recognized separators: &&, ||, ;
 * Pipes (|) are NOT treated as chain separators — they form a single pipeline.
 *
 * Examples:
 *   "git add . && git commit -m 'msg'" → ["git add .", "git commit -m 'msg'"]
 *   "cd /tmp; rm -rf *"              → ["cd /tmp", "rm -rf *"]
 *   "ls -la"                          → ["ls -la"]
 */
export function splitChainCommands(command: string): string[] {
  return command.split(CHAIN_SEPARATOR).map(c => c.trim()).filter(c => c.length > 0);
}

// =============================================================================
// WHITELIST CHECKING — strict mode auto-approve
// =============================================================================

/**
 * Check if ALL sub-commands in a (possibly chained) command are whitelisted.
 * For a chain like "git add . && git commit -m 'msg'", BOTH sub-commands
 * must individually match a whitelist pattern for the whole chain to pass.
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
    let subMatched = false;
    for (const pattern of config.strictModeWhiteList) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(sub)) {
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

/**
 * Generate a regex pattern from a single bash command.
 * Escapes special chars while preserving command structure.
 */
export function generateWhitelistPattern(command: string): string {
  const trimmed = command.trim();
  // Escape regex special chars, preserving the literal command as a pattern
  return trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generate whitelist patterns for each sub-command in a (possibly chained) command.
 * Splits on &&, ||, ; and generates a regex pattern for each individual command.
 *
 * Example:
 *   "git add . && git commit -m 'msg'"
 *   → ["git add \\.", "git commit -m 'msg'"]
 */
export function generateWhitelistPatterns(command: string): string[] {
  return splitChainCommands(command).map(cmd => generateWhitelistPattern(cmd));
}

/**
 * Add a single pattern to the strictModeWhiteList in the project's .pi/patterns.yaml.
 * Creates the file and directory if they don't exist.
 * Does NOT duplicate existing patterns.
 */
export function addPatternToWhitelist(cwd: string, pattern: string): { added: boolean; reason: string } {
  const result = addPatternsToWhitelist(cwd, [pattern]);
  return { added: result.added > 0, reason: result.reason };
}

/**
 * Add multiple patterns to the strictModeWhiteList in the project's .pi/patterns.yaml.
 * Skips duplicates — only truly new patterns are counted as "added".
 * Creates the file and directory if they don't exist.
 */
export function addPatternsToWhitelist(cwd: string, patterns: string[]): { added: number; skipped: number; reason: string } {
  const piDir = join(cwd, ".pi");
  const patternsPath = join(piDir, "patterns.yaml");

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
  if (existsSync(patternsPath)) {
    try {
      const content = readFileSync(patternsPath, "utf-8");
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
    writeFileSync(patternsPath, yamlStr, "utf-8");
    return { added, skipped, reason: "" };
  } catch (e) {
    return { added: 0, skipped: 0, reason: `Failed to write patterns: ${String(e)}` };
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
