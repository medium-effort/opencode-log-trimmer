import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPTIONS, resolveOptions, resolveTrimTargets } from "./options.js";

test("DEFAULT_OPTIONS carries the documented retention budget", () => {
  assert.equal(DEFAULT_OPTIONS.maxSizeMB, 20);
  assert.equal(DEFAULT_OPTIONS.maxLines, 20000);
  assert.equal(DEFAULT_OPTIONS.maxAgeDays, 14);
  assert.equal(DEFAULT_OPTIONS.intervalMs, 1800000);
  assert.equal(DEFAULT_OPTIONS.trimTargetRatio, 0.5);
});

test("resolveOptions() with no args returns a fresh copy of defaults", () => {
  const resolved = resolveOptions();
  assert.deepEqual(resolved, {
    maxSizeMB: 20,
    maxLines: 20000,
    maxAgeDays: 14,
    intervalMs: 1800000,
    trimTargetRatio: 0.5,
  });
  assert.notEqual(resolved, DEFAULT_OPTIONS);
});

test("resolveOptions({}) returns defaults", () => {
  const resolved = resolveOptions({});
  assert.equal(resolved.maxSizeMB, 20);
  assert.equal(resolved.maxLines, 20000);
  assert.equal(resolved.maxAgeDays, 14);
  assert.equal(resolved.intervalMs, 1800000);
  assert.equal(resolved.trimTargetRatio, 0.5);
  assert.equal(resolved.logPathOverride, undefined);
  assert.equal(resolved.dryRun, undefined);
});

test("resolveOptions merges partial overrides over defaults", () => {
  const resolved = resolveOptions({ maxLines: 100, maxSizeMB: 1 });
  assert.equal(resolved.maxLines, 100);
  assert.equal(resolved.maxSizeMB, 1);
  assert.equal(resolved.maxAgeDays, DEFAULT_OPTIONS.maxAgeDays);
  assert.equal(resolved.intervalMs, DEFAULT_OPTIONS.intervalMs);
});

test("resolveOptions preserves logPathOverride and dryRun when given", () => {
  const resolved = resolveOptions({
    logPathOverride: "/somewhere/opencode.log",
    dryRun: true,
  });
  assert.equal(resolved.logPathOverride, "/somewhere/opencode.log");
  assert.equal(resolved.dryRun, true);
});

test("resolveOptions never throws for missing or odd inputs", () => {
  assert.doesNotThrow(() => resolveOptions());
  assert.doesNotThrow(() => resolveOptions({}));
  assert.doesNotThrow(() =>
    resolveOptions(undefined as unknown as Partial<typeof DEFAULT_OPTIONS>),
  );
  assert.doesNotThrow(() =>
    resolveOptions(null as unknown as Partial<typeof DEFAULT_OPTIONS>),
  );
  assert.doesNotThrow(() =>
    resolveOptions({ maxLines: undefined, dryRun: undefined }),
  );
});

test("resolveOptions preserves a custom trimTargetRatio", () => {
  assert.equal(resolveOptions({ trimTargetRatio: 0.8 }).trimTargetRatio, 0.8);
  assert.equal(resolveOptions({ trimTargetRatio: 1 }).trimTargetRatio, 1);
});

test("resolveOptions clamps invalid trimTargetRatio inputs", () => {
  assert.equal(resolveOptions({}).trimTargetRatio, 0.5);
  assert.equal(resolveOptions({ trimTargetRatio: 0 }).trimTargetRatio, 0.5);
  assert.equal(resolveOptions({ trimTargetRatio: -2 }).trimTargetRatio, 0.5);
  assert.equal(resolveOptions({ trimTargetRatio: NaN }).trimTargetRatio, 0.5);
  assert.equal(resolveOptions({ trimTargetRatio: 7 }).trimTargetRatio, 1);
});

test("resolveTrimTargets scales limits by the ratio", () => {
  const atHalf = resolveTrimTargets(
    resolveOptions({ maxLines: 20000, maxSizeMB: 20 }),
  );
  assert.equal(atHalf.targetLines, 10000);
  assert.equal(atHalf.targetBytes, Math.floor(20 * 1024 * 1024 * 0.5));
  const custom = resolveTrimTargets(
    resolveOptions({ maxLines: 10, maxSizeMB: 1, trimTargetRatio: 0.8 }),
  );
  assert.equal(custom.targetLines, 8);
  assert.equal(custom.targetBytes, Math.floor(1 * 1024 * 1024 * 0.8));
});
