import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldTrim, trimLog } from "./trim.js";
import { resolveOptions } from "./options.js";

let fixtureCounter = 0;

async function makeLogDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `opencode-trim-fixture-${process.pid}-${Date.now()}-${fixtureCounter++}`,
  );
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeLog(dir: string, content: string): Promise<string> {
  const logPath = path.join(dir, "opencode.log");
  await fsp.writeFile(logPath, content, "utf8");
  return logPath;
}

async function cleanupDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

test("shouldTrim returns true when size exceeds maxSizeMB", () => {
  const opts = resolveOptions();
  const big = Math.floor(opts.maxSizeMB * 1024 * 1024) + 1;
  assert.equal(
    shouldTrim({ sizeBytes: big, mtimeMs: Date.now() }, 10, opts),
    true,
  );
});

test("shouldTrim returns true when lines exceed maxLines", () => {
  const opts = resolveOptions();
  assert.equal(
    shouldTrim(
      { sizeBytes: 10, mtimeMs: Date.now() },
      opts.maxLines + 1,
      opts,
    ),
    true,
  );
});

test("shouldTrim returns true when mtime is older than maxAgeDays", () => {
  const opts = resolveOptions();
  const old = Date.now() - (opts.maxAgeDays + 1) * 86400000;
  assert.equal(shouldTrim({ sizeBytes: 10, mtimeMs: old }, 1, opts), true);
});

test("shouldTrim returns false when everything is within limits", () => {
  const opts = resolveOptions();
  assert.equal(
    shouldTrim({ sizeBytes: 10, mtimeMs: Date.now() }, 1, opts),
    false,
  );
});

test("trimLog reports missing without writing when the log is absent", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = path.join(dir, "opencode.log");
    const opts = resolveOptions({ logPathOverride: logPath });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, false);
    assert.equal(result.reason, "missing");
    assert.equal(result.beforeBytes, 0);
    assert.equal(result.afterBytes, 0);
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, []);
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog leaves a within-limits file untouched", async () => {
  const dir = await makeLogDir();
  try {
    const content = "line one\nline two\n";
    const logPath = await writeLog(dir, content);
    const before = await fsp.readFile(logPath, "utf8");
    const opts = resolveOptions({ logPathOverride: logPath });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, false);
    assert.equal(result.reason, "within-limits");
    assert.equal(result.beforeBytes, Buffer.byteLength(content, "utf8"));
    assert.equal(result.afterBytes, result.beforeBytes);
    assert.equal(result.beforeLines, 2);
    assert.equal(result.afterLines, 2);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, before);
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog dryRun is strictly read-only and byte-identical", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `fixture entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 3,
      trimTargetRatio: 1,
      maxAgeDays: 365,
      dryRun: true,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.ok(result.reason.startsWith("dry-run:"));
    assert.equal(result.beforeLines, 10);
    assert.equal(result.afterLines, 3);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, content);
    assert.equal(
      Buffer.byteLength(after, "utf8"),
      Buffer.byteLength(content, "utf8"),
    );
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog tail satisfies ALL of size and lines limits", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `line-${String(i).padStart(3, "0")}-${"x".repeat(40)}`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const maxLines = 5;
    const maxSizeMB = 0.0005;
    const maxBytes = Math.floor(maxSizeMB * 1024 * 1024);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines,
      maxSizeMB,
      maxAgeDays: 365,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.equal(result.beforeLines, 20);
    assert.ok(result.afterLines <= maxLines);
    assert.ok(result.afterBytes <= maxBytes);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(Buffer.byteLength(after, "utf8") <= maxBytes, true);
    const afterLines = after.split("\n").filter((l) => l.length > 0);
    assert.ok(afterLines.length <= maxLines);
    assert.equal(afterLines[afterLines.length - 1], lines[lines.length - 1]);
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog age pass drops old lines and retains unparseable ones", async () => {
  const dir = await makeLogDir();
  try {
    const oldStamp = "2000-01-01T00:00:00.000Z";
    const recentStamp = new Date().toISOString();
    const content =
      `${oldStamp} this old line must go\n` +
      `${recentStamp} this recent line must stay\n` +
      `this line has no timestamp and must stay\n`;
    const logPath = await writeLog(dir, content);
    const ancient = Date.now() - 20 * 86400000;
    await fsp.utimes(logPath, new Date(), new Date(ancient));
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 20000,
      maxSizeMB: 20,
      maxAgeDays: 14,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.ok(result.reason.includes("age"));
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after.includes("this old line must go"), false);
    assert.equal(after.includes("this recent line must stay"), true);
    assert.equal(after.includes("this line has no timestamp"), true);
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog rewrites via same-dir scratch plus rename with no residue", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `fixture entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const logPath = await writeLog(dir, `${lines.join("\n")}\n`);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 4,
      trimTargetRatio: 1,
      maxAgeDays: 365,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.equal(result.afterLines, 4);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, `${lines.slice(-4).join("\n")}\n`);
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
    for (const entry of entries) {
      assert.equal(entry.startsWith("opencode.log.scratch-"), false);
    }
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog locked-dest surfaces error:write-failed with after==before and no residue", async () => {
  const dir = await makeLogDir();
  const originalRename = fsp.rename;
  const originalCopyFile = fsp.copyFile;
  const originalOpen = fsp.open;
  const originalConsoleError = console.error;
  const captured: string[] = [];
  (console as unknown as { error: (...args: unknown[]) => void }).error = (
    ...args: unknown[]
  ) => {
    try {
      captured.push(args.map((a) => String(a)).join(" "));
    } catch {
      // Never throw from the spy.
    }
  };
  (fsp as unknown as Record<string, unknown>)["rename"] =
    async (): Promise<void> => {
      const err = new Error(
        "EPERM: operation not permitted, rename (locked-dest simulation)",
      ) as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };
  // v0.3.7: rename denial alone now falls back to copyFile then r+, so
  // the all-layers-denied path must stub copyFile AND open as well to
  // still surface error:write-failed.
  (fsp as unknown as Record<string, unknown>)["copyFile"] =
    async (): Promise<void> => {
      const err = new Error(
        "EPERM: operation not permitted, copyFile (locked-dest simulation)",
      ) as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };
  (fsp as unknown as Record<string, unknown>)["open"] =
    async (): Promise<never> => {
      const err = new Error(
        "EPERM: operation not permitted, open (locked-dest simulation)",
      ) as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `locked entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 4,
      trimTargetRatio: 1,
      maxAgeDays: 365,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, false);
    assert.equal(result.reason, "error:write-failed");
    assert.equal(result.afterBytes, result.beforeBytes);
    assert.equal(result.afterLines, result.beforeLines);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, content);
    const entries = await fsp.readdir(dir);
    assert.ok(entries.includes("opencode.log"));
    for (const entry of entries) {
      assert.ok(
        !entry.includes("scratch"),
        `scratch residue should not remain: ${entry}`,
      );
      assert.ok(
        !entry.startsWith("temp_") && !entry.startsWith("legacy_"),
        `forbidden prefix in fixture dir: ${entry}`,
      );
    }
    assert.ok(
      captured.length > 0,
      "expected guarded console.error errno surfacing",
    );
    assert.ok(
      captured.some((m) => m.includes("EPERM") && m.includes(logPath)),
      `expected path+code errno line, got: ${JSON.stringify(captured)}`,
    );
  } finally {
    (fsp as unknown as Record<string, unknown>)["rename"] = originalRename;
    (fsp as unknown as Record<string, unknown>)["copyFile"] = originalCopyFile;
    (fsp as unknown as Record<string, unknown>)["open"] = originalOpen;
    (console as unknown as { error: (...args: unknown[]) => void }).error =
      originalConsoleError;
    await cleanupDir(dir);
  }
});

test("trimLog retries a transient rename failure and succeeds", async () => {
  const dir = await makeLogDir();
  const originalRename = fsp.rename;
  let calls = 0;
  (fsp as unknown as Record<string, unknown>)["rename"] = async (
    oldPath: unknown,
    newPath: unknown,
  ): Promise<void> => {
    calls += 1;
    if (calls <= 2) {
      const err = new Error(
        "EPERM: operation not permitted, rename (transient simulation)",
      ) as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    }
    await (originalRename as (a: unknown, b: unknown) => Promise<void>)(
      oldPath,
      newPath,
    );
  };
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `retry entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const logPath = await writeLog(dir, `${lines.join("\n")}\n`);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 4,
      trimTargetRatio: 1,
      maxAgeDays: 365,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.equal(calls, 3);
    assert.equal(result.afterLines, 4);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, `${lines.slice(-4).join("\n")}\n`);
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
  } finally {
    (fsp as unknown as Record<string, unknown>)["rename"] = originalRename;
    await cleanupDir(dir);
  }
});

test("trimLog single-pass tail budget handles large synthetic log quickly", async () => {
  const dir = await makeLogDir();
  try {
    const count = 40000;
    const lines = Array.from(
      { length: count },
      (_, i) => `line-${String(i).padStart(6, "0")}-${"x".repeat(100)}`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const maxLines = 5000;
    const maxSizeMB = 0.5;
    const maxBytes = Math.floor(maxSizeMB * 1024 * 1024);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines,
      maxSizeMB,
      maxAgeDays: 365,
    });
    const started = Date.now();
    const result = await trimLog(opts);
    const elapsed = Date.now() - started;
    assert.equal(result.trimmed, true);
    assert.ok(elapsed < 2000, `trim took ${elapsed}ms, expected <2000ms`);
    assert.ok(result.afterLines <= maxLines);
    assert.ok(result.afterBytes <= maxBytes);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(Buffer.byteLength(after, "utf8") <= maxBytes, true);
    const afterLines = after.split("\n").filter((l) => l.length > 0);
    assert.ok(afterLines.length <= maxLines);
    assert.equal(afterLines[afterLines.length - 1], lines[lines.length - 1]);
    assert.equal(result.afterLines, afterLines.length);
    assert.equal(result.afterBytes, Buffer.byteLength(after, "utf8"));
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog falls back to copyFile when rename is denied, tail-correct with no residue", async () => {
  const dir = await makeLogDir();
  const originalRename = fsp.rename;
  const originalConsoleError = console.error;
  const captured: string[] = [];
  (console as unknown as { error: (...args: unknown[]) => void }).error = (
    ...args: unknown[]
  ) => {
    try {
      captured.push(args.map((a) => String(a)).join(" "));
    } catch {
      // Never throw from the spy.
    }
  };
  (fsp as unknown as Record<string, unknown>)["rename"] =
    async (): Promise<void> => {
      const err = new Error(
        "EPERM: operation not permitted, rename (hot-file simulation)",
      ) as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `copy fallback entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 4,
      trimTargetRatio: 1,
      maxAgeDays: 365,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.ok(result.reason.startsWith("trimmed:"));
    assert.equal(result.afterLines, 4);
    assert.equal(result.afterBytes, Buffer.byteLength(`${lines.slice(-4).join("\n")}\n`, "utf8"));
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, `${lines.slice(-4).join("\n")}\n`);
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
    for (const entry of entries) {
      assert.equal(entry.startsWith("opencode.log.scratch-"), false);
      assert.ok(
        !entry.startsWith("temp_") && !entry.startsWith("legacy_"),
        `forbidden prefix in fixture dir: ${entry}`,
      );
    }
    assert.ok(
      captured.some((m) => m.includes("EPERM") && m.includes(logPath)),
      `expected path+code errno line, got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      captured.some((m) => m.includes("fallback") && m.includes(logPath)),
      `expected fallback path record, got: ${JSON.stringify(captured)}`,
    );
  } finally {
    (fsp as unknown as Record<string, unknown>)["rename"] = originalRename;
    (console as unknown as { error: (...args: unknown[]) => void }).error =
      originalConsoleError;
    await cleanupDir(dir);
  }
});

test("trimLog falls back to r+ truncate+write when rename and copy fail, identity preserved", async () => {
  const dir = await makeLogDir();
  const originalRename = fsp.rename;
  const originalCopyFile = fsp.copyFile;
  const originalConsoleError = console.error;
  const captured: string[] = [];
  (console as unknown as { error: (...args: unknown[]) => void }).error = (
    ...args: unknown[]
  ) => {
    try {
      captured.push(args.map((a) => String(a)).join(" "));
    } catch {
      // Never throw from the spy.
    }
  };
  (fsp as unknown as Record<string, unknown>)["rename"] =
    async (): Promise<void> => {
      const err = new Error(
        "EPERM: operation not permitted, rename (hot-file simulation)",
      ) as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };
  (fsp as unknown as Record<string, unknown>)["copyFile"] =
    async (): Promise<void> => {
      const err = new Error(
        "EPERM: operation not permitted, copyFile (hot-file simulation)",
      ) as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `rplus fallback entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const logPath = await writeLog(dir, `${lines.join("\n")}\n`);
    const beforeStat = await fsp.stat(logPath);
    const beforeIno =
      typeof (beforeStat as unknown as { ino?: unknown }).ino === "number"
        ? ((beforeStat as unknown as { ino: number }).ino as number)
        : 0;
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 4,
      trimTargetRatio: 1,
      maxAgeDays: 365,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.equal(result.afterLines, 4);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, `${lines.slice(-4).join("\n")}\n`);
    const afterStat = await fsp.stat(logPath);
    const afterIno =
      typeof (afterStat as unknown as { ino?: unknown }).ino === "number"
        ? ((afterStat as unknown as { ino: number }).ino as number)
        : 0;
    if (beforeIno !== 0 && afterIno !== 0) {
      assert.equal(
        afterIno,
        beforeIno,
        "r+ fallback must preserve file identity (no rename replacement)",
      );
    }
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
    assert.ok(
      captured.some((m) => m.includes("fallback r+") && m.includes(logPath)),
      `expected r+ fallback record, got: ${JSON.stringify(captured)}`,
    );
  } finally {
    (fsp as unknown as Record<string, unknown>)["rename"] = originalRename;
    (fsp as unknown as Record<string, unknown>)["copyFile"] = originalCopyFile;
    (console as unknown as { error: (...args: unknown[]) => void }).error =
      originalConsoleError;
    await cleanupDir(dir);
  }
});

test("trimLog all fallback layers denied never throws, error:write-failed with after==before", async () => {
  const dir = await makeLogDir();
  const originalRename = fsp.rename;
  const originalCopyFile = fsp.copyFile;
  const originalOpen = fsp.open;
  (fsp as unknown as Record<string, unknown>)["rename"] =
    async (): Promise<void> => {
      const err = new Error("EPERM: rename denied") as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };
  (fsp as unknown as Record<string, unknown>)["copyFile"] =
    async (): Promise<void> => {
      const err = new Error("EPERM: copy denied") as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };
  (fsp as unknown as Record<string, unknown>)["open"] =
    async (): Promise<never> => {
      const err = new Error("EPERM: open denied") as Error & { code?: string };
      err.code = "EPERM";
      throw err;
    };
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `all-fail entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 4,
      trimTargetRatio: 1,
      maxAgeDays: 365,
    });
    let result: Awaited<ReturnType<typeof trimLog>> | null = null;
    let threw = false;
    try {
      result = await trimLog(opts);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "trimLog must never throw to the host");
    assert.ok(result !== null);
    assert.equal((result as { trimmed: boolean }).trimmed, false);
    assert.equal((result as { reason: string }).reason, "error:write-failed");
    assert.equal(
      (result as { afterBytes: number }).afterBytes,
      (result as { beforeBytes: number }).beforeBytes,
    );
    assert.equal(
      (result as { afterLines: number }).afterLines,
      (result as { beforeLines: number }).beforeLines,
    );
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, content);
    const entries = await fsp.readdir(dir);
    assert.ok(entries.includes("opencode.log"));
    for (const entry of entries) {
      assert.ok(
        !entry.includes("scratch"),
        `scratch residue should not remain: ${entry}`,
      );
      assert.ok(
        !entry.startsWith("temp_") && !entry.startsWith("legacy_"),
        `forbidden prefix in fixture dir: ${entry}`,
      );
    }
  } finally {
    (fsp as unknown as Record<string, unknown>)["rename"] = originalRename;
    (fsp as unknown as Record<string, unknown>)["copyFile"] = originalCopyFile;
    (fsp as unknown as Record<string, unknown>)["open"] = originalOpen;
    await cleanupDir(dir);
  }
});

test("trimLog trims while a hot open handle is held, tail-correct with no residue", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `hot handle entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const logPath = await writeLog(dir, `${lines.join("\n")}\n`);
    const holder = await fsp.open(logPath, "r+");
    try {
      const opts = resolveOptions({
        logPathOverride: logPath,
        maxLines: 4,
      trimTargetRatio: 1,
        maxAgeDays: 365,
      });
      const result = await trimLog(opts);
      assert.equal(result.trimmed, true);
      assert.equal(result.afterLines, 4);
      const after = await fsp.readFile(logPath, "utf8");
      assert.equal(after, `${lines.slice(-4).join("\n")}\n`);
      const entries = await fsp.readdir(dir);
      assert.deepEqual(entries, ["opencode.log"]);
    } finally {
      try {
        await holder.close();
      } catch {
        // Best-effort holder cleanup, never throws the test.
      }
    }
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog default hysteresis cuts lines to half the limit", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `hyst entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const logPath = await writeLog(dir, `${lines.join("\n")}\n`);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 4,
      maxAgeDays: 365,
    });
    assert.equal(opts.trimTargetRatio, 0.5);
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.equal(result.afterLines, 2);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, `${lines.slice(-2).join("\n")}\n`);
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog honors a custom trimTargetRatio", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `custom ratio entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const logPath = await writeLog(dir, `${lines.join("\n")}\n`);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 10,
      maxAgeDays: 365,
      trimTargetRatio: 0.8,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.equal(result.afterLines, 8);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, `${lines.slice(-8).join("\n")}\n`);
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog size hysteresis cuts to half the byte budget", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `line-${String(i).padStart(3, "0")}-${"x".repeat(40)}`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const maxSizeMB = 0.0005;
    const maxBytes = Math.floor(maxSizeMB * 1024 * 1024);
    const targetBytes = Math.floor(maxBytes * 0.5);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 20000,
      maxSizeMB,
      maxAgeDays: 365,
    });
    const result = await trimLog(opts);
    assert.equal(result.trimmed, true);
    assert.ok(result.afterBytes <= targetBytes);
    const after = await fsp.readFile(logPath, "utf8");
    assert.ok(Buffer.byteLength(after, "utf8") <= targetBytes);
    const afterLines = after.split("\n").filter((l) => l.length > 0);
    assert.equal(afterLines[afterLines.length - 1], lines[lines.length - 1]);
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, ["opencode.log"]);
  } finally {
    await cleanupDir(dir);
  }
});

test("trimLog hysteresis leaves headroom so the next pass is a no-op", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `headroom entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const logPath = await writeLog(dir, `${lines.join("\n")}\n`);
    const opts = resolveOptions({
      logPathOverride: logPath,
      maxLines: 4,
      maxAgeDays: 365,
    });
    const first = await trimLog(opts);
    assert.equal(first.trimmed, true);
    assert.equal(first.afterLines, 2);
    const second = await trimLog(opts);
    assert.equal(second.trimmed, false);
    assert.equal(second.reason, "within-limits");
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, `${lines.slice(-2).join("\n")}\n`);
  } finally {
    await cleanupDir(dir);
  }
});
