import { test } from "node:test";
import assert from "node:assert/strict";
import { logTrimRpc } from "./rpc.js";

test("logTrimRpc has stable portable id and trim method", () => {
  assert.equal((logTrimRpc as any)?.id, "opencode-log-trimmer");
  const methods = (logTrimRpc as any)?.methods;
  assert.ok(methods, "expected methods map");
  assert.ok(methods.trim, "expected methods.trim");
  assert.ok(methods.trim.input, "expected trim input schema");
  assert.ok(methods.trim.output, "expected trim output schema");
  assert.equal(typeof methods.trim.input, "object");
  assert.equal(typeof methods.trim.output, "object");
});

test("logTrimRpc schemas are JSON-safe and headless-testable", () => {
  const methods = (logTrimRpc as any).methods;
  for (const key of ["input", "output"] as const) {
    const schema = methods.trim[key];
    const roundtripped = JSON.parse(JSON.stringify(schema));
    assert.deepEqual(roundtripped, schema);
  }
  const output = methods.trim.output;
  const props = (output as any)?.properties ?? {};
  for (const field of [
    "trimmed",
    "reason",
    "beforeBytes",
    "afterBytes",
    "beforeLines",
    "afterLines",
  ]) {
    assert.ok(props[field], `expected output property ${field}`);
  }
  assert.ok(
    Array.isArray((output as any)?.required),
    "expected output required list",
  );
  for (const field of [
    "trimmed",
    "reason",
    "beforeBytes",
    "afterBytes",
    "beforeLines",
    "afterLines",
  ]) {
    assert.ok(
      ((output as any).required as Array<string>).includes(field),
      `expected required to include ${field}`,
    );
  }
});

test("logTrimRpc input accepts void or optsOverride without touching disk", () => {
  const methods = (logTrimRpc as any).methods;
  const input = methods.trim.input;
  assert.equal((input as any)?.type, "object");
  // No required top-level fields so void/empty input validates.
  const required = (input as any)?.required;
  assert.ok(
    required === undefined ||
      (Array.isArray(required) && required.length === 0),
    "input must not require fields (void-compatible)",
  );
  const props = (input as any)?.properties ?? {};
  assert.ok(
    props.optsOverride === undefined || typeof props.optsOverride === "object",
    "optsOverride schema must be an object when present",
  );
  const text = JSON.stringify(input);
  assert.ok(!text.includes("fs"), "portable schema must not reference fs");
  assert.ok(!text.includes("os."), "portable schema must not reference os");
  assert.ok(!text.includes("path"), "portable schema must not reference path");
});
