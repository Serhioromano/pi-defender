import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

// =============================================================================
// TYPES
// =============================================================================

export interface BashPattern {
  pattern: string;
  reason: string;
  ask?: boolean;
}

export interface Config {
  bashToolPatterns: BashPattern[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
  noDeletePaths: string[];
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

  // 1. Project-local config (.pi/defender/patterns.yaml)
  paths.push(join(cwd, ".pi", "defender", "patterns.yaml"));

  // 2. Global user config (~/.pi/defender/patterns.yaml)
  paths.push(join(homedir(), ".pi", "defender", "patterns.yaml"));

  return paths;
}

export function loadConfig(cwd: string): Config {
  const configPaths = getConfigPaths(cwd);

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        const raw = parseYaml(content) as Record<string, unknown>;

        return {
          bashToolPatterns: (raw.bashToolPatterns as BashPattern[]) || [],
          zeroAccessPaths: (raw.zeroAccessPaths as string[]) || [],
          readOnlyPaths: (raw.readOnlyPaths as string[]) || [],
          noDeletePaths: (raw.noDeletePaths as string[]) || [],
        };
      } catch {
        // Continue to next fallback
      }
    }
  }

  // No config found — return empty (permissive)
  return {
    bashToolPatterns: [],
    zeroAccessPaths: [],
    readOnlyPaths: [],
    noDeletePaths: [],
  };
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
  ask: boolean;
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
  for (const { pattern, reason, ask: shouldAsk } of config.bashToolPatterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(command)) {
        if (shouldAsk) {
          return { blocked: false, ask: true, reason };
        }
        return { blocked: true, ask: false, reason: `Blocked: ${reason}` };
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
            ask: false,
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
          ask: false,
          reason: `Blocked: zero-access path ${zeroPath} (no operations allowed)`,
        };
      }
    }
  }

  // 3. Check for modifications to read-only paths (reads allowed)
  for (const readonlyPath of config.readOnlyPaths) {
    const result = checkPathPatterns(command, readonlyPath, READ_ONLY_BLOCKED, "read-only path");
    if (result.blocked) {
      return { ...result, ask: false };
    }
  }

  // 4. Check for deletions on no-delete paths (read/write/edit allowed)
  for (const noDeletePath of config.noDeletePaths) {
    const result = checkPathPatterns(command, noDeletePath, NO_DELETE_BLOCKED, "no-delete path");
    if (result.blocked) {
      return { ...result, ask: false };
    }
  }

  return { blocked: false, ask: false, reason: "" };
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
