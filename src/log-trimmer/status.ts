import fs from "fs";
import path from "path";
import { resolveLogPath } from "./path.js";
import type { TrimResult } from "./options.js";

export type TrimStatusSource = "trim-on-load" | "interval" | "command" | "rpc";

export const TRIM_STATUS_FILENAME = "opencode.log.trimmer-status.json";

function toSafeResult(result: TrimResult): {
  trimmed: boolean;
  reason: string;
  beforeBytes: number;
  afterBytes: number;
  beforeLines: number;
  afterLines: number;
} {
  try {
    return {
      trimmed: (result as TrimResult)?.trimmed === true,
      reason:
        typeof (result as TrimResult)?.reason === "string"
          ? (result as TrimResult).reason
          : "unknown",
      beforeBytes:
        typeof (result as TrimResult)?.beforeBytes === "number" &&
        Number.isFinite((result as TrimResult).beforeBytes)
          ? (result as TrimResult).beforeBytes
          : 0,
      afterBytes:
        typeof (result as TrimResult)?.afterBytes === "number" &&
        Number.isFinite((result as TrimResult).afterBytes)
          ? (result as TrimResult).afterBytes
          : 0,
      beforeLines:
        typeof (result as TrimResult)?.beforeLines === "number" &&
        Number.isFinite((result as TrimResult).beforeLines)
          ? (result as TrimResult).beforeLines
          : 0,
      afterLines:
        typeof (result as TrimResult)?.afterLines === "number" &&
        Number.isFinite((result as TrimResult).afterLines)
          ? (result as TrimResult).afterLines
          : 0,
    };
  } catch {
    return {
      trimmed: false,
      reason: "unknown",
      beforeBytes: 0,
      afterBytes: 0,
      beforeLines: 0,
      afterLines: 0,
    };
  }
}

export function writeTrimStatus(
  result: TrimResult,
  source: TrimStatusSource,
  opts?: { logPathOverride?: string },
): void {
  try {
    let logPath: string;
    try {
      logPath = resolveLogPath(opts?.logPathOverride);
    } catch {
      return;
    }
    let logDir: string;
    try {
      logDir = path.dirname(logPath);
    } catch {
      return;
    }
    if (!logDir || logDir.length === 0) {
      return;
    }
    const target = path.join(logDir, TRIM_STATUS_FILENAME);
    const tmp = path.join(
      logDir,
      `${TRIM_STATUS_FILENAME}.tmp-${process.pid}`,
    );
    let payload: string;
    try {
      // v0.3.6 additive-only local-time fields: ts stays EXACTLY
      // new Date().toISOString() UTC for machine readers; tsLocal is a
      // human-local string and tzOffsetMinutes is -getTimezoneOffset().
      // Date/prototype only, no new imports. JSON-safe primitives that
      // old readers ignore.
      const now = new Date();
      let tsLocal: string;
      try {
        tsLocal = now.toLocaleString();
      } catch {
        tsLocal = String(now);
      }
      payload = JSON.stringify({
        ts: now.toISOString(),
        tsLocal,
        tzOffsetMinutes: -now.getTimezoneOffset(),
        pid: process.pid,
        source,
        result: toSafeResult(result),
      });
    } catch {
      return;
    }
    try {
      fs.writeFileSync(tmp, payload, "utf8");
    } catch {
      return;
    }
    try {
      fs.renameSync(tmp, target);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best-effort cleanup only.
      }
    }
  } catch {
    // Fire-and-forget: never throw to the host.
  }
}
