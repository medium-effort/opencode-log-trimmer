import { test } from "node:test";
import assert from "node:assert/strict";
import { tuiPlugin, formatTrimError, isTrimUnavailable, TRIM_UNAVAILABLE_HINT } from "./tui.js";
import def from "./tui.js";

function makeStubCtx(
  trimImpl?: (...args: Array<any>) => Promise<unknown>,
  stubOpts?: { directory?: string },
) {
  const slots: Array<any> = [];
  const layers: Array<any> = [];
  const toasts: Array<any> = [];
  const rpcCalls: Array<unknown> = [];
  const trimCalls: Array<{ input: unknown; options: unknown }> = [];
  let inRender = false;
  const rawTrim =
    trimImpl ??
    (async () => ({
      trimmed: true,
      reason: "trimmed-lines",
      beforeBytes: 2097152,
      afterBytes: 1048576,
      beforeLines: 20061,
      afterLines: 20000,
    }));
  const trim = async (...args: Array<any>) => {
    trimCalls.push({ input: args[0], options: args[1] });
    return rawTrim(...args);
  };
  const directory = stubOpts?.directory;
  const ctx: any = {
    ...(directory !== undefined
      ? {
          location: { directory },
          data: { location: { default: () => ({ directory }) } },
        }
      : {}),
    keymap: {
      // Owner gate: the host only provides a Solid owner inside a
      // slot-mounted render. A direct-in-setup layer() call throws
      // Keymap.Provider is missing (swallowed by old setup -> no palette).
      layer: (input: () => any) => {
        if (!inRender) {
          throw new Error("Keymap.Provider is missing");
        }
        layers.push(input());
      },
    },
    client: {
      rpc: (...args: Array<unknown>) => {
        rpcCalls.push(args);
        return { trim };
      },
    },
    ui: {
      slot: (claim: any) => {
        slots.push(claim);
        return () => {};
      },
      toast: {
        show: (opts: any) => {
          toasts.push(opts);
        },
      },
    },
  };
  const renderSlots = () => {
    inRender = true;
    try {
      for (const slot of slots) {
        slot.render({});
      }
    } finally {
      inRender = false;
    }
  };
  return { ctx, slots, layers, toasts, rpcCalls, trimCalls, renderSlots };
}

function silenceSetup(ctx: any) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.doesNotThrow(() => (tuiPlugin as any).setup(ctx));
  } finally {
    console.log = originalLog;
  }
}

test("tui module loads with stable identity and setup function", () => {
  assert.ok(tuiPlugin, "expected tuiPlugin export");
  assert.ok(def, "expected default export");
  assert.equal((tuiPlugin as any)?.id, "opencode-log-trimmer-tui");
  assert.equal((def as any)?.id, "opencode-log-trimmer-tui");
  assert.equal(tuiPlugin, def);
  assert.equal(typeof (tuiPlugin as any)?.setup, "function");
});

test("setup emits guarded tui setup loaded log first", () => {
  const { ctx } = makeStubCtx();
  const lines: Array<unknown> = [];
  const originalLog = console.log;
  console.log = (...args: Array<unknown>) => {
    lines.push(args.join(" "));
  };
  try {
    (tuiPlugin as any).setup(ctx);
  } finally {
    console.log = originalLog;
  }
  assert.ok(
    lines.length >= 1,
    `expected at least one console.log, got ${lines.length}`,
  );
  assert.ok(
    String(lines[0]).includes("[opencode-log-trimmer] tui setup loaded"),
    `expected tui setup loaded first, got: ${String(lines[0])}`,
  );
});

test("setup registers exactly one app slot and defers layer to render (owner-scoped)", () => {
  const { ctx, slots, layers, renderSlots } = makeStubCtx();
  silenceSetup(ctx);
  // Exactly one slot claim, no direct layer call during setup.
  assert.equal(slots.length, 1);
  assert.equal(
    layers.length,
    0,
    "layer must NOT be called directly in setup (no Solid owner)",
  );
  const claim = slots[0];
  assert.equal(claim.append, "app");
  assert.equal(typeof claim.render, "function");
  // Mounting the slot (owner present) registers exactly one layer.
  renderSlots();
  assert.equal(layers.length, 1);
  const layer = layers[0];
  assert.equal(layer.mode, "global");
  assert.ok(Array.isArray(layer.commands));
  assert.equal(layer.commands.length, 1);
  const cmd = layer.commands[0];
  assert.equal(cmd.id, "log-trimmer.trim");
  assert.equal(cmd.slash?.name, "log-trim");
  assert.equal(cmd.palette, true);
  assert.equal(typeof cmd.run, "function");
});

test("slot render returns null (no solid/jsx)", () => {
  const { ctx, slots } = makeStubCtx();
  silenceSetup(ctx);
  assert.equal(slots.length, 1);
  const out = (slots[0] as any).render({});
  assert.equal(out, null);
});

test("owner gate: direct-in-setup layer call throws, slot-render placement passes", () => {
  const { ctx, slots, layers, renderSlots } = makeStubCtx();
  // A legacy direct-in-setup implementation hits the owner gate.
  const badSetup = (c: any) => c.keymap.layer(() => ({ mode: "global" }));
  assert.throws(() => badSetup(ctx), /Keymap\.Provider is missing/);
  // The real setup never calls layer directly, so it never hits the gate.
  silenceSetup(ctx);
  assert.equal(layers.length, 0);
  assert.equal(slots.length, 1);
  renderSlots();
  assert.equal(layers.length, 1);
});

test("run toasts Trim started immediately then success with budget context", async () => {
  const { ctx, layers, toasts, renderSlots } = makeStubCtx(async () => ({
    trimmed: true,
    reason: "trimmed-lines",
    beforeBytes: 2097152,
    afterBytes: 1048576,
    beforeLines: 20061,
    afterLines: 20000,
  }));
  silenceSetup(ctx);
  renderSlots();
  const run = layers[0].commands[0].run;
  const pending = run() as Promise<void>;
  // Trim started is toasted synchronously before the rpc resolves.
  assert.ok(
    toasts.length >= 1,
    `expected immediate Trim started toast, got ${toasts.length}`,
  );
  assert.equal(toasts[0]?.message, "Trim started");
  await assert.doesNotReject(pending);
  assert.ok(
    toasts.length >= 2,
    `expected success toast after rpc, got ${JSON.stringify(toasts)}`,
  );
  const done = toasts[1];
  assert.ok(
    String(done?.message).includes("Trim done"),
    `expected Trim done, got: ${done?.message}`,
  );
  assert.ok(
    String(done?.message).includes("trimmed-lines"),
    `expected reason in toast, got: ${done?.message}`,
  );
  assert.ok(
    String(done?.message).includes("MB->") ||
      String(done?.message).includes("MB ->"),
    `expected MB budget in toast, got: ${done?.message}`,
  );
  assert.ok(
    String(done?.message).includes("20061->20000"),
    `expected line budget in toast, got: ${done?.message}`,
  );
  assert.equal(done?.variant, "success");
});

test("run toasts skipped when trim returns trimmed:false and error on rpc failure", async () => {
  // Skipped path.
  const skipped = makeStubCtx(async () => ({
    trimmed: false,
    reason: "ok",
    beforeBytes: 100,
    afterBytes: 100,
    beforeLines: 10,
    afterLines: 10,
  }));
  silenceSetup(skipped.ctx);
  skipped.renderSlots();
  await assert.doesNotReject(skipped.layers[0].commands[0].run());
  assert.ok(skipped.toasts.length >= 2);
  assert.equal(skipped.toasts[0]?.message, "Trim started");
  assert.ok(
    String(skipped.toasts[1]?.message).includes("Trim skipped"),
    `expected Trim skipped, got: ${skipped.toasts[1]?.message}`,
  );

  // Error path.
  const failing = makeStubCtx(async () => {
    throw new Error("rpc-boom");
  });
  silenceSetup(failing.ctx);
  failing.renderSlots();
  await assert.doesNotReject(failing.layers[0].commands[0].run());
  assert.ok(failing.toasts.length >= 2);
  assert.equal(failing.toasts[0]?.message, "Trim started");
  assert.ok(
    String(failing.toasts[1]?.message).includes("Trim failed"),
    `expected Trim failed, got: ${failing.toasts[1]?.message}`,
  );
  assert.ok(
    String(failing.toasts[1]?.message).includes("rpc-boom"),
    `expected error detail, got: ${failing.toasts[1]?.message}`,
  );
  assert.equal(failing.toasts[1]?.variant, "error");
});

test("setup never throws on hostile hosts", () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.doesNotThrow(() => (tuiPlugin as any).setup(null));
    assert.doesNotThrow(() => (tuiPlugin as any).setup(undefined));
    assert.doesNotThrow(() => (tuiPlugin as any).setup({}));
    assert.doesNotThrow(() => (tuiPlugin as any).setup({ keymap: {} }));
    assert.doesNotThrow(() => (tuiPlugin as any).setup({ ui: {} }));
    assert.doesNotThrow(() =>
      (tuiPlugin as any).setup({
        ui: {
          slot: () => {
            throw new Error("slot-boom");
          },
        },
      }),
    );
    // Slot render whose inner layer throws must not escape setup or render.
    const hostileRender = makeStubCtx();
    hostileRender.ctx.keymap.layer = () => {
      throw new Error("layer-boom");
    };
    assert.doesNotThrow(() => (tuiPlugin as any).setup(hostileRender.ctx));
    assert.doesNotThrow(() => hostileRender.renderSlots());
    // Toast that throws plus rpc that throws must not escape setup or run.
    const hostile = makeStubCtx(async () => {
      throw new Error("rpc-boom");
    });
    hostile.ctx.ui.toast.show = () => {
      throw new Error("toast-boom");
    };
    assert.doesNotThrow(() => (tuiPlugin as any).setup(hostile.ctx));
    hostile.renderSlots();
  } finally {
    console.log = originalLog;
  }
});

test("formatTrimError handles plain {type,message} without [object Object]", () => {
  const out = formatTrimError({
    type: "rpc-validation",
    message: "invalid input",
    data: { reason: "schema" },
  });
  assert.ok(typeof out === "string" && out.length > 0);
  assert.ok(!out.includes("[object Object]"), `got: ${out}`);
  assert.ok(out.includes("invalid input"), `got: ${out}`);
});

test("formatTrimError handles message-only object", () => {
  const out = formatTrimError({ message: "boom-msg" });
  assert.ok(out.includes("boom-msg"), `got: ${out}`);
  assert.ok(!out.includes("[object Object]"), `got: ${out}`);
});

test("formatTrimError handles type-only object", () => {
  const out = formatTrimError({ type: "rpc-transport" });
  assert.ok(out.includes("rpc-transport"), `got: ${out}`);
  assert.ok(!out.includes("[object Object]"), `got: ${out}`);
});

test("formatTrimError handles bare string rejection", () => {
  const out = formatTrimError("plain-fail");
  assert.equal(out, "plain-fail");
  assert.ok(!out.includes("[object Object]"));
});

test("formatTrimError never throws and truncates long data to 300ch", () => {
  const big = "x".repeat(1000);
  let out: string = "";
  assert.doesNotThrow(() => {
    out = formatTrimError({ type: "t", message: "m", data: big });
  });
  assert.ok(!out.includes("[object Object]"));
  assert.ok(out.includes("m"), `got: ${out.slice(0, 80)}`);
  assert.ok(out.length <= 600, `too long: ${out.length}`);
  // Data portion itself is capped at 300 chars.
  assert.doesNotThrow(() => {
    out = formatTrimError({ data: big });
  });
  assert.ok(out.length <= 300, `expected data truncation, got ${out.length}`);
  assert.doesNotThrow(() => {
    out = formatTrimError(undefined);
  });
  assert.ok(typeof out === "string" && out.length > 0);
  assert.ok(!out.includes("[object Object]"));
  assert.doesNotThrow(() => {
    out = formatTrimError(null);
  });
  assert.ok(!out.includes("[object Object]"));
  const circular: any = {};
  circular.self = circular;
  assert.doesNotThrow(() => {
    out = formatTrimError(circular);
  });
  assert.ok(!out.includes("[object Object]"));
});

test("run calls shared trim RPC with {} and toasts started then success with budget", async () => {
  let rpcInput: unknown = "not-called";
  const { ctx, layers, toasts, renderSlots } = makeStubCtx(async (...args: Array<unknown>) => ({
    trimmed: true,
    reason: "trimmed-lines",
    beforeBytes: 2097152,
    afterBytes: 1048576,
    beforeLines: 20061,
    afterLines: 20000,
  }));
  // Wrap the stub trim to capture its input arg.
  const origRpc = (ctx as any).client.rpc;
  (ctx as any).client.rpc = (...args: Array<unknown>) => {
    const api = origRpc(...args);
    const origTrim = (api as any).trim;
    return {
      trim: (input: unknown) => {
        rpcInput = input;
        return origTrim(input);
      },
    };
  };
  silenceSetup(ctx);
  renderSlots();
  const run = layers[0].commands[0].run;
  const pending = run() as Promise<void>;
  assert.ok(toasts.length >= 1);
  assert.equal(toasts[0]?.message, "Trim started");
  await assert.doesNotReject(pending);
  assert.deepEqual(rpcInput, {}, "trim RPC must be called with {}");
  assert.ok(toasts.length >= 2);
  const done = toasts[1];
  assert.ok(String(done?.message).includes("Trim done"));
  assert.ok(String(done?.message).includes("trimmed-lines"));
  assert.ok(String(done?.message).includes("20061->20000"));
  assert.equal(done?.variant, "success");
});

test("run with plain-object rejection toasts formatted detail, never [object Object]", async () => {
  const failing = makeStubCtx(async () => {
    throw { type: "rpc-validation", message: "bad shape", data: { f: 1 } };
  });
  silenceSetup(failing.ctx);
  failing.renderSlots();
  await assert.doesNotReject(failing.layers[0].commands[0].run());
  assert.ok(failing.toasts.length >= 2);
  assert.equal(failing.toasts[0]?.message, "Trim started");
  const errToast = failing.toasts[1];
  assert.ok(String(errToast?.message).includes("Trim failed"));
  assert.ok(String(errToast?.message).includes("bad shape"), `got: ${errToast?.message}`);
  assert.ok(!String(errToast?.message).includes("[object Object]"), `got: ${errToast?.message}`);
  assert.equal(errToast?.variant, "error");
});

test("isTrimUnavailable detects unavailable rejections", () => {
  assert.equal(isTrimUnavailable(new Error("rpc unavailable")), true);
  assert.equal(isTrimUnavailable("RPC UNAVAILABLE: no handler"), true);
  assert.equal(
    isTrimUnavailable({ type: "rpc", message: "rpc unavailable" }),
    true,
  );
  assert.equal(isTrimUnavailable(new Error("rpc-boom")), false);
  assert.equal(
    isTrimUnavailable({ type: "rpc-validation", message: "bad shape" }),
    false,
  );
  assert.equal(isTrimUnavailable(undefined), false);
});

test("unavailable hint names server id plus reload", () => {
  assert.ok(typeof TRIM_UNAVAILABLE_HINT === "string");
  assert.ok(
    TRIM_UNAVAILABLE_HINT.includes("opencode-log-trimmer"),
    `got: ${TRIM_UNAVAILABLE_HINT}`,
  );
  assert.ok(
    TRIM_UNAVAILABLE_HINT.toLowerCase().includes("reload") ||
      TRIM_UNAVAILABLE_HINT.toLowerCase().includes("restart"),
    `got: ${TRIM_UNAVAILABLE_HINT}`,
  );
});

test("run with unavailable rejection retries once then toasts hint", async () => {
  let calls = 0;
  const stub = makeStubCtx(async () => {
    calls += 1;
    throw { type: "rpc", message: "rpc unavailable" };
  });
  silenceSetup(stub.ctx);
  stub.renderSlots();
  await assert.doesNotReject(stub.layers[0].commands[0].run());
  assert.equal(calls, 2, `expected exactly one retry, got ${calls}`);
  assert.ok(stub.toasts.length >= 2);
  assert.equal(stub.toasts[0]?.message, "Trim started");
  const errToast = stub.toasts[1];
  assert.ok(String(errToast?.message).includes("Trim failed"));
  assert.ok(!String(errToast?.message).includes("[object Object]"));
  assert.ok(
    String(errToast?.message).includes("opencode-log-trimmer"),
    `expected server id hint, got: ${errToast?.message}`,
  );
  assert.ok(
    String(errToast?.message).toLowerCase().includes("reload") ||
      String(errToast?.message).toLowerCase().includes("restart"),
    `expected reload hint, got: ${errToast?.message}`,
  );
  assert.equal(errToast?.variant, "error");
});

test("run with transient unavailable then success toasts done without failure", async () => {
  let calls = 0;
  const stub = makeStubCtx(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("rpc unavailable: starting");
    }
    return {
      trimmed: true,
      reason: "trimmed-lines",
      beforeBytes: 2097152,
      afterBytes: 1048576,
      beforeLines: 20061,
      afterLines: 20000,
    };
  });
  silenceSetup(stub.ctx);
  stub.renderSlots();
  await assert.doesNotReject(stub.layers[0].commands[0].run());
  assert.equal(calls, 2, `expected one retry then success, got ${calls}`);
  assert.ok(stub.toasts.length >= 2);
  assert.equal(stub.toasts[0]?.message, "Trim started");
  const done = stub.toasts[1];
  assert.ok(String(done?.message).includes("Trim done"), `got: ${done?.message}`);
  assert.equal(done?.variant, "success");
});

test("run with non-unavailable error does NOT retry", async () => {
  let calls = 0;
  const stub = makeStubCtx(async () => {
    calls += 1;
    throw new Error("rpc-boom");
  });
  silenceSetup(stub.ctx);
  stub.renderSlots();
  await assert.doesNotReject(stub.layers[0].commands[0].run());
  assert.equal(calls, 1, `expected no retry for non-unavailable, got ${calls}`);
  const errToast = stub.toasts[1];
  assert.ok(String(errToast?.message).includes("Trim failed"));
  assert.ok(!String(errToast?.message).includes("opencode-log-trimmer"));
});

test("run routes trim RPC with location+header when directory resolves", async () => {
  const dir = "/tmp/instance-repo";
  const stub = makeStubCtx(undefined, { directory: dir });
  silenceSetup(stub.ctx);
  stub.renderSlots();
  await assert.doesNotReject(stub.layers[0].commands[0].run());
  assert.equal(stub.trimCalls.length, 1, `expected one trim call, got ${stub.trimCalls.length}`);
  const call = stub.trimCalls[0] as any;
  assert.deepEqual(call.input, {}, "first arg must stay exactly {}");
  assert.ok(call.options !== undefined, "expected second-arg routing options");
  assert.deepEqual(
    (call.options as any)?.location,
    { directory: dir },
    "location must echo directory",
  );
  assert.equal(
    (call.options as any)?.headers?.["x-opencode-directory"],
    dir,
    "header must echo directory",
  );
  assert.ok(stub.toasts.length >= 2);
  assert.equal(stub.toasts[0]?.message, "Trim started");
  assert.ok(String(stub.toasts[1]?.message).includes("Trim done"));
});

test("run carries SAME location+header options on single unavailable retry", async () => {
  const dir = "/tmp/instance-repo";
  let calls = 0;
  const stub = makeStubCtx(
    async () => {
      calls += 1;
      throw { type: "rpc", message: "rpc unavailable" };
    },
    { directory: dir },
  );
  silenceSetup(stub.ctx);
  stub.renderSlots();
  await assert.doesNotReject(stub.layers[0].commands[0].run());
  assert.equal(calls, 2, `expected exactly one retry, got ${calls}`);
  assert.equal(stub.trimCalls.length, 2, `expected two trim calls, got ${stub.trimCalls.length}`);
  for (const call of stub.trimCalls) {
    const c = call as any;
    assert.deepEqual(c.input, {}, "first arg must stay exactly {} on both calls");
    assert.deepEqual(
      c.options?.location,
      { directory: dir },
      "retry must carry SAME location",
    );
    assert.equal(
      c.options?.headers?.["x-opencode-directory"],
      dir,
      "retry must carry SAME header",
    );
  }
  const errToast = stub.toasts[1];
  assert.ok(String(errToast?.message).includes("Trim failed"));
  assert.ok(String(errToast?.message).includes("opencode-log-trimmer"));
});

test("run falls back to data.location.default when ctx.location missing", async () => {
  const dir = "/tmp/fallback-repo";
  const stub = makeStubCtx(undefined, { directory: dir });
  // Drop the direct location so only the default() fallback remains.
  delete (stub.ctx as any).location;
  assert.equal((stub.ctx as any)?.location, undefined);
  silenceSetup(stub.ctx);
  stub.renderSlots();
  await assert.doesNotReject(stub.layers[0].commands[0].run());
  assert.equal(stub.trimCalls.length, 1);
  const call = stub.trimCalls[0] as any;
  assert.deepEqual(call.input, {}, "first arg must stay exactly {}");
  assert.deepEqual(call.options?.location, { directory: dir });
  assert.equal(call.options?.headers?.["x-opencode-directory"], dir);
});

test("run degrades to legacy trim({}) when no directory resolves", async () => {
  const stub = makeStubCtx();
  assert.equal((stub.ctx as any)?.location, undefined);
  assert.equal((stub.ctx as any)?.data, undefined);
  silenceSetup(stub.ctx);
  stub.renderSlots();
  await assert.doesNotReject(stub.layers[0].commands[0].run());
  assert.equal(stub.trimCalls.length, 1);
  const call = stub.trimCalls[0] as any;
  assert.deepEqual(call.input, {}, "first arg must stay exactly {}");
  assert.equal(call.options, undefined, "expected no second arg when no directory");
  assert.ok(String(stub.toasts[1]?.message).includes("Trim done"));
});

test("run with hostile location/default never throws and degrades", async () => {
  const stub = makeStubCtx();
  silenceSetup(stub.ctx);
  stub.renderSlots();
  // Hostile shapes: throwing getters plus throwing default().
  const hostileDir = {
    get directory(): unknown {
      throw new Error("location-boom");
    },
  };
  (stub.ctx as any).location = hostileDir;
  (stub.ctx as any).data = {
    location: {
      default: () => {
        throw new Error("default-boom");
      },
    },
  };
  await assert.doesNotReject(stub.layers[0].commands[0].run());
  assert.ok(stub.trimCalls.length >= 1);
  const call = stub.trimCalls[0] as any;
  assert.deepEqual(call.input, {}, "first arg must stay exactly {}");
  assert.equal(call.options, undefined, "hostile resolve must degrade to legacy");
  assert.ok(stub.toasts.length >= 2);
  assert.equal(stub.toasts[0]?.message, "Trim started");
  // Null-data hostile run also never throws.
  const hostile2 = makeStubCtx();
  silenceSetup(hostile2.ctx);
  hostile2.renderSlots();
  (hostile2.ctx as any).location = null;
  (hostile2.ctx as any).data = null;
  await assert.doesNotReject(hostile2.layers[0].commands[0].run());
  assert.equal((hostile2.trimCalls[0] as any)?.options, undefined);
});
