import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeTrimStatus, TRIM_STATUS_FILENAME } from "./status.js";
import type { TrimStatusSource } from "./status.js";
import { trimLog } from "./trim.js";
import { resolveOptions } from "./options.js";
import type { TrimResult } from "./options.js";

let fixtureCounter = 0;

async function makeLogDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `opencode-trim-status-${process.pid}-${Date.now()}-${fixtureCounter++}`,
  );
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanupDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

function sampleResult(overrides?: Partial<TrimResult>): TrimResult {
  return {
    trimmed: true,
    reason: "trimmed:lines",
    beforeBytes: 1234,
    afterBytes: 567,
    beforeLines: 100,
    afterLines: 20,
    ...(overrides ?? {}),
  };
}

function statusPath(dir: string): string {
  return path.join(dir, TRIM_STATUS_FILENAME);
}

async function readStatus(dir: string): Promise<any> {
  const raw = await fsp.readFile(statusPath(dir), "utf8");
  return JSON.parse(raw);
}

test("writes status file inside the resolved tmp log dir", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = path.join(dir, "opencode.log");
    await fsp.writeFile(logPath, "hello\n", "utf8");
    assert.doesNotThrow(() =>
      writeTrimStatus(sampleResult(), "command", {
        logPathOverride: logPath,
      }),
    );
    const st = await fsp.stat(statusPath(dir));
    assert.ok(st.isFile());
  } finally {
    await cleanupDir(dir);
  }
});

test("payload carries ts, pid, source, and full result", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = path.join(dir, "opencode.log");
    await fsp.writeFile(logPath, "a\n", "utf8");
    const input = sampleResult({
      trimmed: false,
      reason: "within-limits",
      beforeBytes: 10,
      afterBytes: 10,
      beforeLines: 2,
      afterLines: 2,
    });
    writeTrimStatus(input, "interval", { logPathOverride: logPath });
    const payload = await readStatus(dir);
    assert.equal(payload.source, "interval");
    assert.equal(typeof payload.ts, "string");
    assert.ok(!Number.isNaN(Date.parse(payload.ts)));
    assert.equal(payload.pid, process.pid);
    assert.deepEqual(payload.result, {
      trimmed: false,
      reason: "within-limits",
      beforeBytes: 10,
      afterBytes: 10,
      beforeLines: 2,
      afterLines: 2,
    });
  } finally {
    await cleanupDir(dir);
  }
});

test("records each of the four sources", async () => {
  const sources: TrimStatusSource[] = [
    "trim-on-load",
    "interval",
    "command",
    "rpc",
  ];
  for (const source of sources) {
    const dir = await makeLogDir();
    try {
      const logPath = path.join(dir, "opencode.log");
      await fsp.writeFile(logPath, "x\n", "utf8");
      writeTrimStatus(sampleResult(), source, {
        logPathOverride: logPath,
      });
      const payload = await readStatus(dir);
      assert.equal(payload.source, source);
    } finally {
      await cleanupDir(dir);
    }
  }
});

test("second write atomically overwrites without leftover tmp files", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = path.join(dir, "opencode.log");
    await fsp.writeFile(logPath, "y\n", "utf8");
    writeTrimStatus(sampleResult({ reason: "trimmed:size" }), "rpc", {
      logPathOverride: logPath,
    });
    const first = await readStatus(dir);
    assert.equal(first.result.reason, "trimmed:size");
    writeTrimStatus(sampleResult({ reason: "within-limits" }), "command", {
      logPathOverride: logPath,
    });
    const second = await readStatus(dir);
    assert.equal(second.source, "command");
    assert.equal(second.result.reason, "within-limits");
    const entries = await fsp.readdir(dir);
    assert.ok(entries.includes("opencode.log"));
    assert.ok(entries.includes(TRIM_STATUS_FILENAME));
    for (const e of entries) {
      assert.ok(
        !e.includes(".tmp-"),
        `leftover tmp file should not remain: ${e}`,
      );
      assert.ok(
        !e.startsWith("temp_") && !e.startsWith("legacy_"),
        `forbidden prefix in fixture dir: ${e}`,
      );
    }
  } finally {
    await cleanupDir(dir);
  }
});

test("status filename is fixed and avoids scratch plus forbidden prefixes", async () => {
  assert.equal(TRIM_STATUS_FILENAME, "opencode.log.trimmer-status.json");
  assert.ok(!TRIM_STATUS_FILENAME.startsWith("temp_"));
  assert.ok(!TRIM_STATUS_FILENAME.startsWith("legacy_"));
  assert.ok(!TRIM_STATUS_FILENAME.includes("scratch"));
});

test("never throws on a missing parent dir", async () => {
  const dir = await makeLogDir();
  try {
    const missing = path.join(
      dir,
      `no-such-parent-${Date.now()}`,
      "opencode.log",
    );
    assert.doesNotThrow(() =>
      writeTrimStatus(sampleResult(), "rpc", {
        logPathOverride: missing,
      }),
    );
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, []);
  } finally {
    await cleanupDir(dir);
  }
});

test("never throws when parent path is a file", async () => {
  const dir = await makeLogDir();
  try {
    const blocker = path.join(dir, "blocker");
    await fsp.writeFile(blocker, "i am a file, not a dir", "utf8");
    const logPath = path.join(blocker, "opencode.log");
    assert.doesNotThrow(() =>
      writeTrimStatus(sampleResult(), "command", {
        logPathOverride: logPath,
      }),
    );
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["blocker"]);
  } finally {
    await cleanupDir(dir);
  }
});

test("returns void synchronously (fire-and-forget, never a promise)", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = path.join(dir, "opencode.log");
    await fsp.writeFile(logPath, "z\n", "utf8");
    const ret = writeTrimStatus(sampleResult(), "trim-on-load", {
      logPathOverride: logPath,
    });
    assert.equal(ret, undefined);
    assert.ok(!(ret as unknown as Promise<unknown> instanceof Promise));
  } finally {
    await cleanupDir(dir);
  }
});

test("status file never affects trimLog size accounting", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `accounting entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = path.join(dir, "opencode.log");
    await fsp.writeFile(logPath, content, "utf8");
    // Seed a large status file first; trimLog must stat only opencode.log.
    writeTrimStatus(
      sampleResult({ beforeBytes: 999999999, afterBytes: 1 }),
      "interval",
      { logPathOverride: logPath },
    );
    const statusRaw = await fsp.readFile(statusPath(dir), "utf8");
    assert.ok(statusRaw.length > 0);
    const expectedBytes = Buffer.byteLength(content, "utf8");
    const res = await trimLog(
      resolveOptions({
        logPathOverride: logPath,
        dryRun: true,
        maxLines: 10,
        trimTargetRatio: 1,
        maxAgeDays: 365,
        maxSizeMB: 20,
      }),
    );
    assert.equal(res.beforeBytes, expectedBytes);
    assert.equal(res.beforeLines, 50);
    assert.equal(res.afterLines, 10);
  } finally {
    await cleanupDir(dir);
  }
});

test("dry-run trim leaves the log untouched while status is still written", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `dry entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = path.join(dir, "opencode.log");
    await fsp.writeFile(logPath, content, "utf8");
    const res = await trimLog(
      resolveOptions({
        logPathOverride: logPath,
        dryRun: true,
        maxLines: 5,
        trimTargetRatio: 1,
        maxAgeDays: 365,
      }),
    );
    assert.equal(res.trimmed, true);
    writeTrimStatus(res, "command", { logPathOverride: logPath });
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, content);
    const payload = await readStatus(dir);
    assert.equal(payload.source, "command");
    assert.equal(payload.result.beforeLines, 30);
    assert.equal(payload.result.afterLines, 5);
  } finally {
    await cleanupDir(dir);
  }
});

test("status write is synchronous: file exists immediately after return", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = path.join(dir, "opencode.log");
    await fsp.writeFile(logPath, "sync\n", "utf8");
    writeTrimStatus(sampleResult(), "rpc", { logPathOverride: logPath });
    // Sync read (no await between write and check) must already see it.
    const exists = fs.existsSync(statusPath(dir));
    assert.equal(exists, true);
  } finally {
    await cleanupDir(dir);
  }
});

test("payload carries UTC ts plus local-time fields, all JSON-safe", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = path.join(dir, "opencode.log");
    await fsp.writeFile(logPath, "local-time\n", "utf8");
    writeTrimStatus(sampleResult(), "command", { logPathOverride: logPath });
    const payload = await readStatus(dir);
    assert.equal(typeof payload.ts, "string");
    assert.ok(!Number.isNaN(Date.parse(payload.ts)));
    assert.ok(
      payload.ts.endsWith("Z"),
      `ts must stay toISOString UTC, got: ${payload.ts}`,
    );
    assert.equal(typeof payload.tsLocal, "string");
    assert.ok(payload.tsLocal.length > 0);
    assert.equal(typeof payload.tzOffsetMinutes, "number");
    assert.ok(Number.isFinite(payload.tzOffsetMinutes));
    assert.equal(payload.tzOffsetMinutes, -new Date().getTimezoneOffset());
    assert.doesNotThrow(() => JSON.stringify(payload));
    const roundTrip = JSON.parse(JSON.stringify(payload));
    assert.equal(roundTrip.ts, payload.ts);
    assert.equal(roundTrip.tsLocal, payload.tsLocal);
    assert.equal(roundTrip.tzOffsetMinutes, payload.tzOffsetMinutes);
  } finally {
    await cleanupDir(dir);
  }
});

test("malformed result input is coerced and never throws", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = path.join(dir, "opencode.log");
    await fsp.writeFile(logPath, "m\n", "utf8");
    assert.doesNotThrow(() =>
      writeTrimStatus(
        {
          trimmed: "yes",
          reason: 42,
          beforeBytes: NaN,
          afterBytes: Infinity,
          beforeLines: "lots",
          afterLines: null,
        } as unknown as TrimResult,
        "interval",
        { logPathOverride: logPath },
      ),
    );
    const payload = await readStatus(dir);
    assert.equal(payload.source, "interval");
    assert.equal(typeof payload.result.reason, "string");
    assert.equal(typeof payload.result.beforeBytes, "number");
    assert.equal(typeof payload.result.afterBytes, "number");
  } finally {
    await cleanupDir(dir);
  }
});
