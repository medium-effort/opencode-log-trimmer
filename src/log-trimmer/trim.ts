import { promises as fsp } from "fs";
import path from "path";
import type { TrimOptions, TrimResult } from "./options.js";
import { resolveLogPath } from "./path.js";
import { parseLogTimestamp } from "./age.js";

export function shouldTrim(
  stat: { sizeBytes: number; mtimeMs: number },
  lineCount: number,
  opts: TrimOptions,
): boolean {
  try {
    const maxBytes = Math.floor(opts.maxSizeMB * 1024 * 1024);
    if (typeof stat.sizeBytes === "number" && stat.sizeBytes > maxBytes) {
      return true;
    }
    if (typeof lineCount === "number" && lineCount > opts.maxLines) {
      return true;
    }
    if (
      typeof stat.mtimeMs === "number" &&
      Date.now() - stat.mtimeMs > opts.maxAgeDays * 86400000
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function emptyResult(reason: string): TrimResult {
  return {
    trimmed: false,
    reason,
    beforeBytes: 0,
    afterBytes: 0,
    beforeLines: 0,
    afterLines: 0,
  };
}

// v0.3.6 retry hardening: de-collided scratch counter plus guarded errno
// surfacing (terminal post-quit scrollback only, never throws, never routed
// to opencode.log) plus global-timer rename delay. No new imports.
let scratchCounter = 0;

function errnoLabel(err: unknown): string {
  try {
    const e = err as { code?: unknown; name?: unknown; message?: unknown };
    const code = typeof e?.code === "string" ? (e as { code: string }).code : "";
    const name = typeof e?.name === "string" ? (e as { name: string }).name : "";
    const tagged = [code, name].filter((s) => s.length > 0).join("/");
    if (tagged.length > 0) {
      return tagged;
    }
    const msg = typeof e?.message === "string" ? (e as { message: string }).message : String(err);
    return msg;
  } catch {
    return "unknown";
  }
}

function reportErrno(op: string, targetPath: string, err: unknown): void {
  try {
    console.error(
      `[opencode-log-trimmer] ${op} failed for ${targetPath} (${errnoLabel(err)})`,
    );
  } catch {
    // Never throw to the host: scrollback signal only.
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      setTimeout(resolve, ms);
    } catch {
      resolve();
    }
  });
}

export async function trimLog(opts: TrimOptions): Promise<TrimResult> {
  try {
    const logPath = resolveLogPath(opts.logPathOverride);

    let stat: { size: number; mtimeMs: number };
    try {
      stat = await fsp.stat(logPath);
    } catch {
      return emptyResult("missing");
    }

    let content: string;
    try {
      content = await fsp.readFile(logPath, "utf8");
    } catch {
      return {
        trimmed: false,
        reason: "error:read-failed",
        beforeBytes: typeof stat.size === "number" ? stat.size : 0,
        afterBytes: typeof stat.size === "number" ? stat.size : 0,
        beforeLines: 0,
        afterLines: 0,
      };
    }

    const beforeBytes = Buffer.byteLength(content, "utf8");
    const hadTrailingNewline = content.endsWith("\n");
    let lines: string[];
    if (content.length === 0) {
      lines = [];
    } else {
      lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
    }
    const beforeLines = lines.length;
    const mtimeMs = stat.mtimeMs;

    if (
      !shouldTrim(
        { sizeBytes: beforeBytes, mtimeMs },
        beforeLines,
        opts,
      )
    ) {
      return {
        trimmed: false,
        reason: "within-limits",
        beforeBytes,
        afterBytes: beforeBytes,
        beforeLines,
        afterLines: beforeLines,
      };
    }

    const maxBytes = Math.floor(opts.maxSizeMB * 1024 * 1024);
    const cutoff = Date.now() - opts.maxAgeDays * 86400000;

    // Age pass: drop lines with a parseable timestamp older than the
    // cutoff. Unparseable lines are always retained.
    const ageKept: string[] = [];
    let ageDropped = 0;
    for (const line of lines) {
      const ts = parseLogTimestamp(line);
      if (ts !== null && ts < cutoff) {
        ageDropped += 1;
        continue;
      }
      ageKept.push(line);
    }

    // Lines pass: keep the tail so the most recent lines win.
    let kept = ageKept;
    const linesTruncated = kept.length > opts.maxLines;
    if (linesTruncated) {
      kept = kept.slice(-opts.maxLines);
    }

    // Size pass (single-pass tail budget): keep the tail bytes so the
    // most recent content wins. Precompute per-line bytes once and walk
    // from the tail — no repeated join/byteLength loop.
    const lineBytes: number[] = new Array<number>(kept.length);
    let totalWithNewlines = 0;
    for (let i = 0; i < kept.length; i++) {
      const b = Buffer.byteLength(kept[i] as string, "utf8") + 1;
      lineBytes[i] = b;
      totalWithNewlines += b;
    }
    const totalBytes =
      kept.length === 0
        ? 0
        : hadTrailingNewline
          ? totalWithNewlines
          : totalWithNewlines - 1;
    let sizeTruncated = totalBytes > maxBytes;
    let out: string;
    if (!sizeTruncated) {
      out =
        kept.length === 0
          ? ""
          : hadTrailingNewline
            ? `${kept.join("\n")}\n`
            : kept.join("\n");
    } else {
      let acc = 0;
      let cutoff = kept.length;
      for (let i = kept.length - 1; i >= 0; i--) {
        acc += lineBytes[i] as number;
        const suffixBytes = hadTrailingNewline ? acc : (acc as number) - 1;
        if ((suffixBytes as number) <= maxBytes) {
          cutoff = i;
        } else {
          break;
        }
      }
      if (kept.length === 0) {
        cutoff = 0;
      } else if (cutoff >= kept.length) {
        // Even the last line alone exceeds the budget: keep it and
        // fall back to the tail bytes of the serialized output below.
        cutoff = kept.length - 1;
      }
      kept = kept.slice(cutoff);
      out =
        kept.length === 0
          ? ""
          : hadTrailingNewline
            ? `${kept.join("\n")}\n`
            : kept.join("\n");
      if (Buffer.byteLength(out, "utf8") > maxBytes) {
        // A single line still exceeds the budget:
        // keep the tail bytes of the serialized output.
        const buf = Buffer.from(out, "utf8");
        out = buf.slice(buf.length - maxBytes).toString("utf8");
      }
    }

    const afterBytes = Buffer.byteLength(out, "utf8");
    const afterLines = kept.length;

    const triggers: string[] = [];
    if (beforeBytes > maxBytes || sizeTruncated) {
      triggers.push("size");
    }
    if (beforeLines > opts.maxLines || linesTruncated) {
      triggers.push("lines");
    }
    if (ageDropped > 0 || Date.now() - mtimeMs > opts.maxAgeDays * 86400000) {
      triggers.push("age");
    }
    const reason =
      triggers.length > 0 ? `trimmed:${triggers.join("+")}` : "trimmed";

    if (opts.dryRun) {
      return {
        trimmed: true,
        reason: `dry-run:${reason}`,
        beforeBytes,
        afterBytes,
        beforeLines,
        afterLines,
      };
    }

    // Atomic rewrite via a sibling scratch file in the SAME log
    // directory followed by rename. Never delete outright and never
    // truncate the original in place. v0.3.6: de-collided scratch name,
    // RENAME step ONLY retried up to 3 attempts ~250-500ms apart against
    // transient hot-file EPERM; failure reason stays EXACTLY
    // error:write-failed with after==before (no suffix).
    // v0.3.7 GUARDED HOT-FILE FALLBACK (trim.ts ONLY, strict layered
    // order rename -> copyFile overwrite -> r+ truncate+write): ONLY
    // after the scratch write succeeds AND every rename attempt fails,
    // fall back to fs copyFile (scratch over logPath, needs only WRITE
    // share, preserves the file identity the logger holds), and ONLY if
    // copy fails, fall back to r+ truncate+write (open logPath r+,
    // ftruncate(0), write trimmed bytes). Scratch is retained until a
    // replacement path succeeds; unlinked best-effort same-dir in ALL
    // terminal paths, never throws. Per-step errno surfaced ONLY via
    // guarded console.error with path plus code/name (post-quit
    // scrollback only, never thrown, never routed to opencode.log);
    // the failure reason string stays EXACTLY error:write-failed with
    // after==before (no suffix).
    const logDir = path.dirname(logPath);
    scratchCounter += 1;
    const scratch = path.join(
      logDir,
      `opencode.log.scratch-${process.pid}-${Date.now()}-${scratchCounter}`,
    );
    function reportFallback(note: string, targetPath: string): void {
      try {
        console.error(`[opencode-log-trimmer] fallback ${note} for ${targetPath}`);
      } catch {
        // Never throw to the host: scrollback signal only.
      }
    }
    try {
      try {
        await fsp.writeFile(scratch, out, "utf8");
      } catch (writeErr) {
        reportErrno("scratch write", scratch, writeErr);
        try {
          await fsp.unlink(scratch);
        } catch (unlinkErr) {
          reportErrno("scratch cleanup", scratch, unlinkErr);
        }
        return {
          trimmed: false,
          reason: "error:write-failed",
          beforeBytes,
          afterBytes: beforeBytes,
          beforeLines,
          afterLines: beforeLines,
        };
      }
      let renamed = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fsp.rename(scratch, logPath);
          renamed = true;
          break;
        } catch (renameErr) {
          reportErrno(`rename attempt ${attempt}/3`, logPath, renameErr);
          if (attempt < 3) {
            await sleepMs(300);
          }
        }
      }
      let replaced = renamed;
      if (!renamed) {
        // Layer 2: copyFile overwrite (scratch over logPath). Scratch
        // write already succeeded and every rename failed, so the
        // scratch is retained for this step.
        try {
          reportFallback("copy attempt (scratch over log)", logPath);
          await fsp.copyFile(scratch, logPath);
          replaced = true;
          reportFallback("copy succeeded", logPath);
        } catch (copyErr) {
          reportErrno("fallback copy", logPath, copyErr);
          // Layer 3: r+ truncate+write. ONLY attempted when copy fails.
          try {
            reportFallback("r+ truncate+write attempt", logPath);
            const fh = await fsp.open(logPath, "r+");
            try {
              await fh.truncate(0);
              await fh.writeFile(out, "utf8");
            } finally {
              try {
                await fh.close();
              } catch (closeErr) {
                reportErrno("fallback r+ close", logPath, closeErr);
              }
            }
            replaced = true;
            reportFallback("r+ truncate+write succeeded", logPath);
          } catch (rplusErr) {
            reportErrno("fallback r+ truncate+write", logPath, rplusErr);
            replaced = false;
          }
        }
      }
      if (!renamed) {
        // Scratch still exists on the copy/r+ paths (rename moved it
        // on success). Best-effort same-dir cleanup in ALL terminal
        // paths, never throws.
        try {
          await fsp.unlink(scratch);
        } catch (unlinkErr) {
          reportErrno("scratch cleanup", scratch, unlinkErr);
        }
      }
      if (!replaced) {
        return {
          trimmed: false,
          reason: "error:write-failed",
          beforeBytes,
          afterBytes: beforeBytes,
          beforeLines,
          afterLines: beforeLines,
        };
      }
    } catch (unexpectedErr) {
      reportErrno("scratch rewrite", logPath, unexpectedErr);
      try {
        await fsp.unlink(scratch);
      } catch (unlinkErr) {
        reportErrno("scratch cleanup", scratch, unlinkErr);
      }
      return {
        trimmed: false,
        reason: "error:write-failed",
        beforeBytes,
        afterBytes: beforeBytes,
        beforeLines,
        afterLines: beforeLines,
      };
    }

    return {
      trimmed: true,
      reason,
      beforeBytes,
      afterBytes,
      beforeLines,
      afterLines,
    };
  } catch {
    return emptyResult("error");
  }
}
