import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerLogTrimCommand } from "./command.js";
import { resolveOptions } from "./options.js";
import plugin from "./index.js";

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

async function waitFor(
  cond: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Harness {
  ctx: unknown;
  captured: () => any;
  stored: Array<{ key: string; value: any }>;
  syntheticSeen: any[];
}

function makeHarness(
  logPath: string,
  overrides?: Record<string, unknown>,
): Harness {
  let captured: any = undefined;
  const stored: Array<{ key: string; value: any }> = [];
  const syntheticSeen: any[] = [];
  const opts = resolveOptions({
    logPathOverride: logPath,
    dryRun: true,
    maxLines: 3,
    maxAgeDays: 365,
    ...(overrides ?? {}),
  });
  const ctx: any = {
    command: {
      transform: (cb: (editor: any) => void) => {
        cb({
          add: (def: any) => {
            captured = def;
          },
        });
      },
    },
    storage: {
      set: async (key: string, value: any) => {
        stored.push({ key, value });
      },
    },
    session: {
      synthetic: async (args: any) => {
        // Silent mode: any call is a regression. Record then fail loudly
        // so the zero-synthetic assertion catches it.
        syntheticSeen.push(args);
        throw new Error("session.synthetic must not be called in silent mode");
      },
    },
  };
  // Attach the opts getter via closure on the harness caller side.
  (ctx as any).__getOpts = () => opts;
  return {
    ctx,
    captured: () => captured,
    stored,
    syntheticSeen,
  };
}

function getOptsOf(h: Harness): () => ReturnType<typeof resolveOptions> {
  return () => (h.ctx as any).__getOpts();
}

async function settle(ms = 100): Promise<void> {
  await sleep(ms);
}

test("registerLogTrimCommand registers the log-trim-silent command", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = await writeLog(dir, "one\ntwo\n");
    const h = makeHarness(logPath);
    assert.doesNotThrow(() => registerLogTrimCommand(h.ctx, getOptsOf(h)));
    const def = h.captured();
    assert.ok(def, "expected command definition to be captured");
    assert.equal(def.name, "log-trim-silent");
    assert.equal(typeof def.description, "string");
    assert.ok(def.description.length > 0);
    assert.ok(
      def.description.toLowerCase().includes("silent") ||
        def.description.toLowerCase().includes("non-tui"),
      `expected silent fallback description, got: ${def.description}`,
    );
    assert.equal(typeof def.execute, "function");
  } finally {
    await cleanupDir(dir);
  }
});

test("execute runs a dry-run trim silently and reports lastTrim without writing", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `fixture entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const h = makeHarness(logPath);
    registerLogTrimCommand(h.ctx, getOptsOf(h));
    const def = h.captured();
    assert.ok(def, "expected command definition to be captured");
    // SessionID accepted but ignored. Execute is non-blocking: it resolves
    // immediately and finishes trim in the background, so poll for storage.
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(def.execute({ sessionID: "ses_123" }));
      await waitFor(() => h.stored.length >= 1);
      // Allow any stray synthetic to fire before asserting silence.
      await settle();
    } finally {
      console.error = originalError;
    }
    assert.equal(h.stored.length, 1);
    assert.equal(h.stored[0].key, "lastTrim");
    const result = h.stored[0].value;
    assert.equal(result.trimmed, true);
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.includes("trimmed"));
    assert.equal(result.beforeLines, 10);
    assert.equal(result.afterLines, 3);
    assert.ok(result.beforeBytes > 0);
    assert.ok(result.afterBytes > 0);
    // Dry-run is strictly read-only: bytes identical, no extra files.
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, content);
    assert.equal(
      Buffer.byteLength(after, "utf8"),
      Buffer.byteLength(content, "utf8"),
    );
    // v0.3.5 Option B: tail-able status file is written on every server
    // trim path alongside the untouched log; dry-run still never rewrites
    // the log itself and never leaves scratch/forbidden files.
    const entries = await fsp.readdir(dir);
    const sortedEntries = [...entries].sort();
    assert.ok(
      sortedEntries.length >= 1 &&
        sortedEntries.length <= 2 &&
        sortedEntries.includes("opencode.log") &&
        sortedEntries.every(
          (e) =>
            e === "opencode.log" ||
            e === "opencode.log.trimmer-status.json",
        ),
      `expected only log plus status file, got: ${JSON.stringify(entries)}`,
    );
    // Fully silent: zero synthetic calls despite sessionID input.
    assert.equal(h.syntheticSeen.length, 0);
  } finally {
    await cleanupDir(dir);
  }
});

test("execute reports missing for an absent log silently without writing", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = path.join(dir, "opencode.log");
    const h = makeHarness(logPath);
    registerLogTrimCommand(h.ctx, getOptsOf(h));
    const def = h.captured();
    assert.ok(def, "expected command definition to be captured");
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(def.execute({ sessionID: "ses_abc" }));
      await waitFor(() => h.stored.length >= 1);
      await settle();
    } finally {
      console.error = originalError;
    }
    assert.equal(h.stored.length, 1);
    assert.equal(h.stored[0].key, "lastTrim");
    assert.equal(h.stored[0].value.trimmed, false);
    assert.equal(h.stored[0].value.reason, "missing");
    // v0.3.5 Option B: even a missing-log trim records a status file so a
    // second terminal can observe the pass; the log itself is never created.
    const missingEntries = await fsp.readdir(dir);
    assert.deepEqual(missingEntries, ["opencode.log.trimmer-status.json"]);
    // Silent: no progress and no result synthetic.
    assert.equal(h.syntheticSeen.length, 0);
  } finally {
    await cleanupDir(dir);
  }
});

test("register and execute never throw on hostile hosts", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = await writeLog(dir, "hello\n");
    const opts = () =>
      resolveOptions({ logPathOverride: logPath, dryRun: true });

    // Missing transform.
    assert.doesNotThrow(() =>
      registerLogTrimCommand({ command: {} }, opts),
    );
    // Null ctx.
    assert.doesNotThrow(() => registerLogTrimCommand(null, opts));
    assert.doesNotThrow(() => registerLogTrimCommand(undefined, opts));
    // Transform that throws synchronously.
    assert.doesNotThrow(() =>
      registerLogTrimCommand(
        {
          command: {
            transform: () => {
              throw new Error("boom");
            },
          },
        },
        opts,
      ),
    );
    // Transform that returns a rejected promise.
    assert.doesNotThrow(() =>
      registerLogTrimCommand(
        {
          command: {
            transform: () => Promise.reject(new Error("async-boom")),
          },
        },
        opts,
      ),
    );
    // Editor without add.
    assert.doesNotThrow(() =>
      registerLogTrimCommand(
        {
          command: {
            transform: (cb: any) => {
              cb({});
            },
          },
        },
        opts,
      ),
    );
    // Add that throws.
    assert.doesNotThrow(() =>
      registerLogTrimCommand(
        {
          command: {
            transform: (cb: any) => {
              cb({
                add: () => {
                  throw new Error("add-boom");
                },
              });
            },
          },
        },
        opts,
      ),
    );
    // Storage.set that rejects plus synthetic that throws must not escape.
    let captured: any = undefined;
    const syntheticSeen: any[] = [];
    const failingCtx: any = {
      command: {
        transform: (cb: any) => {
          cb({
            add: (def: any) => {
              captured = def;
            },
          });
        },
      },
      storage: {
        set: async () => {
          throw new Error("storage-boom");
        },
      },
      session: {
        synthetic: async (args: any) => {
          syntheticSeen.push(args);
          throw new Error("synthetic-boom");
        },
      },
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.doesNotThrow(() => registerLogTrimCommand(failingCtx, opts));
    } finally {
      console.error = originalError;
    }
    assert.ok(captured, "expected command definition to be captured");
    const muted = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(captured.execute({ sessionID: "ses_x" }));
      await assert.doesNotReject(captured.execute());
      await settle();
    } finally {
      console.error = muted;
    }
    // Silent mode never calls synthetic even on hostile hosts.
    assert.equal(syntheticSeen.length, 0);
    // File untouched by the hostile-host passes (dry-run fixture).
    await sleep(50);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, "hello\n");
  } finally {
    await cleanupDir(dir);
  }
});

test("execute is non-blocking with slow storage stub and stays silent", async () => {
  const dir = await makeLogDir();
  try {
    // Larger fixture so the real trimLog pass is non-trivial (slow trim).
    const lines = Array.from(
      { length: 5000 },
      (_, i) => `slow entry ${String(i).padStart(5, "0")} :: payload padding`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);

    const stored: Array<{ key: string; value: any }> = [];
    const syntheticSeen: any[] = [];
    const opts = resolveOptions({
      logPathOverride: logPath,
      dryRun: true,
      maxLines: 100,
      maxAgeDays: 365,
    });
    let captured: any = undefined;
    const slowCtx: any = {
      command: {
        transform: (cb: (editor: any) => void) => {
          cb({
            add: (def: any) => {
              captured = def;
            },
          });
        },
      },
      storage: {
        // Slow store: 800ms delay must not hold execute.
        set: async (key: string, value: any) => {
          await sleep(800);
          stored.push({ key, value });
        },
      },
      session: {
        // Must never be called in silent mode.
        synthetic: async (args: any) => {
          syntheticSeen.push(args);
          throw new Error("synthetic must not be called");
        },
      },
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      registerLogTrimCommand(slowCtx, () => opts);
    } finally {
      console.error = originalError;
    }
    assert.ok(captured, "expected command definition to be captured");

    const startedAt = Date.now();
    const muted = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(
        captured.execute({ sessionID: "ses_slow" }),
      );
    } finally {
      console.error = muted;
    }
    const elapsed = Date.now() - startedAt;
    // If execute awaited the slow store it would take >=800ms.
    // Non-blocking execute must resolve well under that budget.
    assert.ok(
      elapsed < 800,
      `expected non-blocking execute (<800ms) but took ${elapsed}ms`,
    );

    // Silent: no progress synthetic fires synchronously.
    assert.equal(syntheticSeen.length, 0);

    // Background result arrives later via storage only.
    const muted2 = console.error;
    console.error = () => {};
    try {
      await waitFor(() => stored.length >= 1, 8000);
      await settle();
    } finally {
      console.error = muted2;
    }
    assert.equal(stored[0].key, "lastTrim");
    assert.equal(stored[0].value.beforeLines, 5000);
    assert.equal(stored[0].value.afterLines, 100);
    assert.equal(syntheticSeen.length, 0);

    // Dry-run fixture untouched, no scratch files.
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, content);
    // v0.3.5 Option B: tail-able status file is written on every server
    // trim path alongside the untouched log; dry-run still never rewrites
    // the log itself and never leaves scratch/forbidden files.
    const entries = await fsp.readdir(dir);
    const sortedEntries = [...entries].sort();
    assert.ok(
      sortedEntries.length >= 1 &&
        sortedEntries.length <= 2 &&
        sortedEntries.includes("opencode.log") &&
        sortedEntries.every(
          (e) =>
            e === "opencode.log" ||
            e === "opencode.log.trimmer-status.json",
        ),
      `expected only log plus status file, got: ${JSON.stringify(entries)}`,
    );
  } finally {
    await cleanupDir(dir);
  }
});

test("execute accepts sessionID but stays silent including undefined", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = await writeLog(dir, "a\nb\nc\nd\n");
    const syntheticSeen: any[] = [];
    const stored: Array<{ key: string; value: any }> = [];
    const opts = resolveOptions({
      logPathOverride: logPath,
      dryRun: true,
      maxLines: 2,
      maxAgeDays: 365,
    });
    let captured: any = undefined;
    const ctx: any = {
      command: {
        transform: (cb: (editor: any) => void) => {
          cb({
            add: (def: any) => {
              captured = def;
            },
          });
        },
      },
      storage: {
        set: async (key: string, value: any) => {
          stored.push({ key, value });
        },
      },
      session: {
        synthetic: async (args: any) => {
          syntheticSeen.push(args);
        },
      },
    };
    registerLogTrimCommand(ctx, () => opts);
    assert.ok(captured, "expected command definition to be captured");

    const originalError = console.error;
    console.error = () => {};
    try {
      // Explicit sessionID is accepted but ignored: no synthetic.
      await assert.doesNotReject(captured.execute({ sessionID: "ses_999" }));
      await waitFor(() => stored.length >= 1);
      await settle();
      assert.equal(syntheticSeen.length, 0);

      // Undefined sessionID (no input) must also never throw and stay silent.
      syntheticSeen.length = 0;
      stored.length = 0;
      await assert.doesNotReject(captured.execute());
      await assert.doesNotReject(captured.execute({ sessionID: undefined }));
      await waitFor(() => stored.length >= 2, 8000);
      await settle(200);
    } finally {
      console.error = originalError;
    }
    assert.equal(syntheticSeen.length, 0);
    assert.ok(stored.length >= 2);
    for (const entry of stored) {
      assert.equal(entry.key, "lastTrim");
      assert.equal(typeof entry.value.reason, "string");
    }
  } finally {
    await cleanupDir(dir);
  }
});

test("execute never rejects when storage.set rejects and stays silent", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = await writeLog(dir, "x\ny\nz\nw\n");
    const syntheticSeen: any[] = [];
    const opts = resolveOptions({
      logPathOverride: logPath,
      dryRun: true,
      maxLines: 2,
      maxAgeDays: 365,
    });
    let captured: any = undefined;
    const ctx: any = {
      command: {
        transform: (cb: (editor: any) => void) => {
          cb({
            add: (def: any) => {
              captured = def;
            },
          });
        },
      },
      storage: {
        set: async () => {
          throw new Error("persist-boom");
        },
      },
      session: {
        synthetic: async (args: any) => {
          syntheticSeen.push(args);
        },
      },
    };
    registerLogTrimCommand(ctx, () => opts);
    assert.ok(captured, "expected command definition to be captured");
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(captured.execute({ sessionID: "ses_store" }));
      // Settle so any stray synthetic would have fired.
      await settle(200);
    } finally {
      console.error = originalError;
    }
    // Silent even when persist fails: zero synthetics.
    assert.equal(syntheticSeen.length, 0);
  } finally {
    await cleanupDir(dir);
  }
});

test("debug logs on trim start/finish do not throw and include path plus budgets", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `debug entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const syntheticSeen: any[] = [];
    const stored: Array<{ key: string; value: any }> = [];
    const opts = resolveOptions({
      logPathOverride: logPath,
      dryRun: true,
      maxLines: 3,
      maxAgeDays: 365,
    });
    let captured: any = undefined;
    const ctx: any = {
      command: {
        transform: (cb: (editor: any) => void) => {
          cb({
            add: (def: any) => {
              captured = def;
            },
          });
        },
      },
      storage: {
        set: async (key: string, value: any) => {
          stored.push({ key, value });
        },
      },
      session: {
        synthetic: async (args: any) => {
          syntheticSeen.push(args);
          throw new Error("synthetic must not be called");
        },
      },
    };
    assert.doesNotThrow(() => registerLogTrimCommand(ctx, () => opts));
    assert.ok(captured, "expected command definition to be captured");

    const logLines: string[] = [];
    const errorLines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: any[]) => {
      logLines.push(args.map((a) => String(a)).join(" "));
    };
    console.error = (...args: any[]) => {
      errorLines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      // Normal capture: start plus finish logs must be present and must
      // never throw to the host.
      await assert.doesNotReject(captured.execute({ sessionID: "ses_debug" }));
      await waitFor(() => stored.length >= 1);
      await settle(100);
      // Flaky console: even if console.log throws once, execute still
      // resolves and the background persist still arrives via storage.
      const flakyLog = console.log;
      let threwOnce = false;
      console.log = (...args: any[]) => {
        if (!threwOnce) {
          threwOnce = true;
          throw new Error("log-boom");
        }
        (flakyLog as (...a: any[]) => void)(...args);
      };
      stored.length = 0;
      await assert.doesNotReject(captured.execute({ sessionID: "ses_debug2" }));
      console.log = (...args: any[]) => {
        logLines.push(args.map((a) => String(a)).join(" "));
      };
      await waitFor(() => stored.length >= 1);
      await settle(100);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    // Start log carries path plus budgets; finish carries MB->MB, lines,
    // reason, and path. Either stream counts (error stream is used for
    // error:timeout/error reasons).
    const combined = [...logLines, ...errorLines].join("\n");
    assert.ok(
      combined.includes("trim start"),
      `expected trim start debug log, got: ${combined.slice(0, 500)}`,
    );
    assert.ok(
      combined.includes(logPath),
      "expected debug logs to include the resolved log path",
    );
    assert.ok(
      combined.includes("maxSizeMB=") &&
        combined.includes("maxLines=") &&
        combined.includes("maxAgeDays=") &&
        combined.includes("intervalMs="),
      `expected start log to include budgets, got: ${combined.slice(0, 800)}`,
    );
    assert.ok(
      combined.includes("trim finish"),
      `expected trim finish debug log, got: ${combined.slice(0, 500)}`,
    );
    assert.ok(
      combined.includes("MB->") || combined.includes("MB ->"),
      "expected finish log to include beforeMB->afterMB",
    );
    assert.ok(
      combined.includes("lines ") && combined.includes("reason="),
      "expected finish log to include lines and reason",
    );
    // Silent server: zero synthetics despite debug prints.
    assert.equal(syntheticSeen.length, 0);
    assert.equal(stored[0]?.key, "lastTrim");
    // Dry-run fixture untouched.
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, content);
    // v0.3.5 Option B: tail-able status file is written on every server
    // trim path alongside the untouched log; dry-run still never rewrites
    // the log itself and never leaves scratch/forbidden files.
    const entries = await fsp.readdir(dir);
    const sortedEntries = [...entries].sort();
    assert.ok(
      sortedEntries.length >= 1 &&
        sortedEntries.length <= 2 &&
        sortedEntries.includes("opencode.log") &&
        sortedEntries.every(
          (e) =>
            e === "opencode.log" ||
            e === "opencode.log.trimmer-status.json",
        ),
      `expected only log plus status file, got: ${JSON.stringify(entries)}`,
    );
  } finally {
    await cleanupDir(dir);
  }
});

test("index setup with mocked rpc.register never throws and keeps silent fallback", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `setup entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const stored: Array<{ key: string; value: any }> = [];
    const syntheticSeen: any[] = [];
    const rpcCalls: Array<{ def: any; handlers: any }> = [];
    let commandDef: any = undefined;
    const ctx: any = {
      options: {
        logPathOverride: logPath,
        dryRun: true,
        maxLines: 2,
        maxAgeDays: 365,
      },
      command: {
        transform: (cb: (editor: any) => void) => {
          cb({
            add: (def: any) => {
              commandDef = def;
            },
          });
        },
      },
      storage: {
        set: async (key: string, value: any) => {
          stored.push({ key, value });
        },
      },
      rpc: {
        register: async (def: any, handlers: any) => {
          rpcCalls.push({ def, handlers });
        },
      },
      session: {
        synthetic: async (args: any) => {
          syntheticSeen.push(args);
          throw new Error("synthetic must not be called");
        },
      },
    };

    const logLines: string[] = [];
    const errorLines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: any[]) => {
      logLines.push(args.map((a) => String(a)).join(" "));
    };
    console.error = (...args: any[]) => {
      errorLines.push(args.map((a) => String(a)).join(" "));
    };
    let cleanup: unknown = null;
    try {
      // Setup must never reject even with rpc mocked (rpc.ts may be
      // absent when task_001 is still pending; silent fallback is kept).
      const setupFn = (plugin as unknown as { setup?: unknown })?.setup as
        | ((c: unknown) => Promise<unknown>)
        | undefined;
      assert.ok(
        typeof setupFn === "function",
        "expected plugin setup to be a function",
      );
      await assert.doesNotReject(async () => {
        cleanup = await (setupFn as (c: unknown) => Promise<unknown>)(ctx);
      });
      // Trim-on-load is fire-and-forget: wait for persist.
      await waitFor(() => stored.length >= 1);
      await settle(100);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      try {
        if (typeof cleanup === "function") {
          (cleanup as () => void)();
        }
      } catch {
        // Cleanup must never throw.
      }
    }

    // Silent /log-trim-silent fallback is always registered (v0.3.11:
    // TUI owns log-trim exclusively, server owns log-trim-silent only).
    assert.ok(commandDef, "expected silent log-trim fallback to be kept");
    assert.equal(commandDef.name, "log-trim-silent");
    assert.ok(
      String(commandDef.description ?? "")
        .toLowerCase()
        .includes("silent"),
      `expected silent fallback description, got: ${commandDef.description}`,
    );
    assert.equal(typeof commandDef.execute, "function");
    // No agent turns: zero synthetics across setup plus trim-on-load.
    assert.equal(syntheticSeen.length, 0);
    // Trim-on-load debug prints do not throw and mention the log path.
    const combined = [...logLines, ...errorLines].join("\n");
    assert.ok(
      combined.includes("trim start") || combined.includes("trim finish"),
      `expected setup trim debug logs, got: ${combined.slice(0, 500)}`,
    );
    assert.ok(
      combined.includes(logPath) || combined.includes("rpc"),
      "expected setup logs to mention path or rpc registration",
    );
    // v0.3.11: static import plus direct register — the host register must
    // have been attempted with the shared def and a trim handler.
    assert.ok(
      Array.isArray(rpcCalls),
      "expected rpc call capture to be an array",
    );
    assert.ok(
      rpcCalls.length >= 1,
      `expected direct rpc register call, got ${rpcCalls.length}`,
    );
    {
      const first = rpcCalls[0] as { def: any; handlers: any };
      assert.ok(first?.def, "expected rpc def to be passed to register");
      assert.equal(first?.def?.id, "opencode-log-trimmer");
      assert.equal(typeof first?.handlers?.trim, "function");
    }
    // Dry-run fixture untouched, no scratch files.
    // v0.3.5 Option B: tail-able status file is written on every server
    // trim path alongside the untouched log; dry-run still never rewrites
    // the log itself and never leaves scratch/forbidden files.
    const entries = await fsp.readdir(dir);
    const sortedEntries = [...entries].sort();
    assert.ok(
      sortedEntries.length >= 1 &&
        sortedEntries.length <= 2 &&
        sortedEntries.includes("opencode.log") &&
        sortedEntries.every(
          (e) =>
            e === "opencode.log" ||
            e === "opencode.log.trimmer-status.json",
        ),
      `expected only log plus status file, got: ${JSON.stringify(entries)}`,
    );
  } finally {
    await cleanupDir(dir);
  }
});

test("index setup without ctx.rpc logs loudly and keeps silent fallback", async () => {
  const dir = await makeLogDir();
  try {
    const logPath = await writeLog(dir, "a\nb\n");
    const stored: Array<{ key: string; value: any }> = [];
    let commandDef: any = undefined;
    const ctx: any = {
      options: {
        logPathOverride: logPath,
        dryRun: true,
        maxLines: 100,
        maxAgeDays: 365,
      },
      command: {
        transform: (cb: (editor: any) => void) => {
          cb({
            add: (def: any) => {
              commandDef = def;
            },
          });
        },
      },
      storage: {
        set: async (key: string, value: any) => {
          stored.push({ key, value });
        },
      },
    };
    const errorLines: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.log = () => {};
    console.error = (...args: any[]) => {
      errorLines.push(args.map((a) => String(a)).join(" "));
    };
    let cleanup: unknown = null;
    try {
      const setupFn = (plugin as unknown as { setup?: unknown })?.setup as
        | ((c: unknown) => Promise<unknown>)
        | undefined;
      assert.ok(typeof setupFn === "function");
      await assert.doesNotReject(async () => {
        cleanup = await (setupFn as (c: unknown) => Promise<unknown>)(ctx);
      });
      await waitFor(() => stored.length >= 1);
      await settle(50);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      try {
        if (typeof cleanup === "function") {
          (cleanup as () => void)();
        }
      } catch {
        // Never throw.
      }
    }
    assert.ok(commandDef, "expected fallback command to be kept");
    assert.equal(commandDef.name, "log-trim-silent");
    const combined = errorLines.join("\n");
    assert.ok(
      combined.includes("rpc registration skipped"),
      `expected loud rpc skip, got: ${combined.slice(0, 600)}`,
    );
    assert.ok(
      combined.includes("opencode-log-trimmer"),
      `expected skip to name rpc id, got: ${combined.slice(0, 600)}`,
    );
    assert.ok(
      combined.includes("hostKeys="),
      `expected skip to include host shape, got: ${combined.slice(0, 600)}`,
    );
    assert.equal(stored[0]?.key, "lastTrim");
  } finally {
    await cleanupDir(dir);
  }
});

test("rpc handler trims via direct register and writes source:rpc status", async () => {
  const dir = await makeLogDir();
  try {
    const lines = Array.from(
      { length: 8 },
      (_, i) => `rpc entry ${String(i).padStart(3, "0")} :: payload`,
    );
    const content = `${lines.join("\n")}\n`;
    const logPath = await writeLog(dir, content);
    const stored: Array<{ key: string; value: any }> = [];
    let commandDef: any = undefined;
    const rpcCalls: Array<{ def: any; handlers: any }> = [];
    const ctx: any = {
      options: {
        logPathOverride: logPath,
        dryRun: true,
        maxLines: 3,
        maxAgeDays: 365,
      },
      command: {
        transform: (cb: (editor: any) => void) => {
          cb({
            add: (def: any) => {
              commandDef = def;
            },
          });
        },
      },
      storage: {
        set: async (key: string, value: any) => {
          stored.push({ key, value });
        },
      },
      rpc: {
        register: async (def: any, handlers: any) => {
          rpcCalls.push({ def, handlers });
        },
      },
    };
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    let cleanup: unknown = null;
    try {
      const setupFn = (plugin as unknown as { setup?: unknown })?.setup as
        | ((c: unknown) => Promise<unknown>)
        | undefined;
      assert.ok(typeof setupFn === "function");
      cleanup = await (setupFn as (c: unknown) => Promise<unknown>)(ctx);
      await waitFor(() => stored.length >= 1);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      try {
        if (typeof cleanup === "function") {
          (cleanup as () => void)();
        }
      } catch {
        // Never throw.
      }
    }
    assert.ok(commandDef, "expected fallback command");
    assert.equal(commandDef.name, "log-trim-silent");
    assert.ok(rpcCalls.length >= 1, "expected rpc register call");
    assert.equal(rpcCalls[0]?.def?.id, "opencode-log-trimmer");
    const trimHandler = rpcCalls[0]?.handlers?.trim;
    assert.equal(typeof trimHandler, "function");
    const result = await trimHandler({});
    assert.equal(result.trimmed, true);
    assert.ok(String(result.reason).includes("trimmed"));
    assert.equal(result.beforeLines, 8);
    assert.equal(result.afterLines, 3);
    const statusRaw = await fsp.readFile(
      path.join(dir, "opencode.log.trimmer-status.json"),
      "utf8",
    );
    const status = JSON.parse(statusRaw) as any;
    assert.equal(status.source, "rpc");
    assert.equal(status.result.trimmed, true);
    const after = await fsp.readFile(logPath, "utf8");
    assert.equal(after, content);
  } finally {
    await cleanupDir(dir);
  }
});
