import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolveLogPath } from "./path.js";

test("resolveLogPath passes an explicit override through untouched", () => {
  assert.equal(
    resolveLogPath("/custom/dir/opencode.log"),
    "/custom/dir/opencode.log",
  );
  assert.equal(resolveLogPath("relative/opencode.log"), "relative/opencode.log");
});

test("resolveLogPath defaults to homedir-joined global log path", () => {
  const expected = path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode",
    "log",
    "opencode.log",
  );
  assert.equal(resolveLogPath(), expected);
  assert.equal(resolveLogPath(undefined), expected);
});

test("resolveLogPath treats empty override as missing", () => {
  const expected = path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode",
    "log",
    "opencode.log",
  );
  assert.equal(resolveLogPath(""), expected);
});

test("resolveLogPath never throws", () => {
  assert.doesNotThrow(() => resolveLogPath());
  assert.doesNotThrow(() => resolveLogPath(undefined));
  assert.doesNotThrow(() => resolveLogPath(""));
  assert.doesNotThrow(() =>
    resolveLogPath(null as unknown as string | undefined),
  );
});
