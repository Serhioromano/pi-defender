import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkCommand,
  checkPathPatterns,
  rightGlobBoundary,
  READ_ONLY_BLOCKED,
  NO_DELETE_BLOCKED,
  type Config,
} from "../src/config.ts";

function cfg(over: Partial<Config> = {}): Config {
  return {
    bashToolPatterns: [],
    zeroAccessPaths: [],
    readOnlyPaths: [],
    noDeletePaths: [],
    strictModeWhiteList: [],
    defaultMode: undefined,
    ...over,
  };
}

// --- Regression: the reported false positive --------------------------------

test("zero-access glob does not fire on identifier substrings", () => {
  const c = cfg({ zeroAccessPaths: ["*.key", "*.pem"] });
  // `Object.keys` contains `.key` — previously matched the unanchored `*.key`.
  assert.equal(checkCommand('node -e "console.log(Object.keys(x))"', c).blocked, false);
  assert.equal(
    checkCommand("const m=require('./dist/agent-registry.js'); console.log(Object.keys(m))", c).blocked,
    false,
  );
  assert.equal(checkCommand("grep foo bar.keystore", c).blocked, false);
  assert.equal(checkCommand("echo pubkey.pemission", c).blocked, false);
});

// --- Real protection must be preserved --------------------------------------

test("zero-access glob still blocks real key/pem path tokens", () => {
  const c = cfg({ zeroAccessPaths: ["*.key", "*.pem"] });
  assert.equal(checkCommand("cat myprivate.key", c).blocked, true);
  assert.equal(checkCommand("cat cert.pem", c).blocked, true);
  assert.equal(checkCommand("cp /home/u/tls.key /tmp/x", c).blocked, true);
  assert.equal(checkCommand("openssl rsa -in server.key -out out", c).blocked, true);
});

test("zero-access literal paths and directory prefixes are unchanged", () => {
  const c = cfg({ zeroAccessPaths: ["~/.ssh/", "id_rsa"] });
  assert.equal(checkCommand("cat ~/.ssh/id_rsa", c).blocked, true);
  assert.equal(checkCommand("cat ~/.ssh/config", c).blocked, true);
  assert.equal(checkCommand("ssh-add id_rsa", c).blocked, true);
});

test("zero-access directory glob still prefix-matches a longer path", () => {
  const c = cfg({ zeroAccessPaths: ["secrets*/"] });
  assert.equal(checkCommand("cat secrets_prod/app.yaml", c).blocked, true);
});

// --- Same class of bug in read-only / no-delete glob matching ---------------

test("read-only glob right-bounds a longer token", () => {
  const hit = checkPathPatterns("sed -i 's/a/b/' app.min.js", "*.min.js", READ_ONLY_BLOCKED, "read-only path");
  const miss = checkPathPatterns("sed -i 's/a/b/' app.min.json", "*.min.js", READ_ONLY_BLOCKED, "read-only path");
  assert.equal(hit.blocked, true);
  assert.equal(miss.blocked, false);
});

test("no-delete glob right-bounds a longer token", () => {
  const hit = checkPathPatterns("rm yarn.lock", "*.lock", NO_DELETE_BLOCKED, "no-delete path");
  const miss = checkPathPatterns("rm yarn.locksmith", "*.lock", NO_DELETE_BLOCKED, "no-delete path");
  assert.equal(hit.blocked, true);
  assert.equal(miss.blocked, false);
});

// --- Helper contract --------------------------------------------------------

test("rightGlobBoundary omits the word boundary for directory globs", () => {
  assert.equal(rightGlobBoundary("*.key"), "(?![\\w])");
  assert.equal(rightGlobBoundary("*.min.js"), "(?![\\w])");
  assert.equal(rightGlobBoundary("secrets*/"), "");
});
