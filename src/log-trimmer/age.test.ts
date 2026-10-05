import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLogTimestamp } from "./age.js";

test("parseLogTimestamp resolves a leading ISO instant", () => {
  const line = "2024-01-15T10:30:00.000Z some log message";
  const expected = Date.parse("2024-01-15T10:30:00.000Z");
  assert.equal(parseLogTimestamp(line), expected);
  assert.equal(typeof parseLogTimestamp(line), "number");
});

test("parseLogTimestamp resolves a space-separated ISO-like stamp", () => {
  const line = "2024-01-15 10:30:00 trailing content here";
  const result = parseLogTimestamp(line);
  assert.equal(typeof result, "number");
  assert.ok((result as number) > 0);
});

test("parseLogTimestamp resolves a bracketed leading timestamp", () => {
  const line = "[2024-01-15T10:30:00.000Z] some log message";
  const expected = Date.parse("2024-01-15T10:30:00.000Z");
  assert.equal(parseLogTimestamp(line), expected);
});

test("parseLogTimestamp resolves a parenthesized leading timestamp", () => {
  const line = "(2024-01-15T10:30:00.000Z) some log message";
  const expected = Date.parse("2024-01-15T10:30:00.000Z");
  assert.equal(parseLogTimestamp(line), expected);
});

test("parseLogTimestamp returns null for garbage without a timestamp", () => {
  assert.equal(parseLogTimestamp("hello world no timestamp here"), null);
  assert.equal(parseLogTimestamp("!!!not-a-timestamp!!!"), null);
  assert.equal(parseLogTimestamp("just some log line without date"), null);
});

test("parseLogTimestamp returns null for empty or blank lines", () => {
  assert.equal(parseLogTimestamp(""), null);
  assert.equal(parseLogTimestamp("   "), null);
});

test("parseLogTimestamp never throws for odd inputs", () => {
  assert.doesNotThrow(() => parseLogTimestamp("hello world"));
  assert.doesNotThrow(() =>
    parseLogTimestamp(null as unknown as string),
  );
  assert.doesNotThrow(() =>
    parseLogTimestamp(undefined as unknown as string),
  );
  assert.doesNotThrow(() =>
    parseLogTimestamp(123 as unknown as string),
  );
  assert.equal(parseLogTimestamp(null as unknown as string), null);
  assert.equal(parseLogTimestamp(undefined as unknown as string), null);
});
