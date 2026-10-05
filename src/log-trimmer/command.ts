import type { TrimOptions, TrimResult } from "./options.js";
import { trimLog } from "./trim.js";
import { resolveLogPath } from "./path.js";
import { writeTrimStatus } from "./status.js";

function safeLogPath(opts: TrimOptions): string {
  try {
    return resolveLogPath(opts.logPathOverride);
  } catch {
    try {
      const fallback = (opts as { logPathOverride?: unknown })
        ?.logPathOverride;
      return typeof fallback === "string" && fallback.length > 0
        ? fallback
        : "unknown";
    } catch {
      return "unknown";
    }
  }
}

function logTrimStart(logPath: string, opts: TrimOptions): void {
  try {
    console.log(
      `[opencode-log-trimmer] trim start path=${logPath} ` +
        `maxSizeMB=${opts.maxSizeMB} maxLines=${opts.maxLines} ` +
        `maxAgeDays=${opts.maxAgeDays} intervalMs=${opts.intervalMs}`,
    );
  } catch {
    // Debug logs must never throw to the host.
  }
}

function logTrimFinish(logPath: string, r: TrimResult): void {
  try {
    const beforeMB = (r.beforeBytes / 1048576).toFixed(3);
    const afterMB = (r.afterBytes / 1048576).toFixed(3);
    const msg =
      `[opencode-log-trimmer] trim finish ${beforeMB}MB->${afterMB}MB ` +
      `lines ${r.beforeLines}->${r.afterLines} ` +
      `reason=${r.reason} path=${logPath}`;
    if (typeof r.reason === "string" && r.reason.startsWith("error")) {
      console.error(msg);
    } else {
      console.log(msg);
    }
  } catch {
    // Debug logs must never throw to the host.
  }
}

export function registerLogTrimCommand(
  ctx: unknown,
  getOpts: () => TrimOptions,
): void {
  try {
    const anyCtx = ctx as any;
    const transform = anyCtx?.command?.transform;
    if (typeof transform !== "function") {
      console.error(
        "[opencode-log-trimmer] command transform unavailable, skipping log-trim-silent registration",
      );
      return;
    }
    try {
      const maybePromise = transform(async (editor: any) => {
        try {
          const add = (editor as any)?.add;
          if (typeof add !== "function") {
            console.error(
              "[opencode-log-trimmer] command add unavailable, skipping log-trim-silent registration",
            );
            return;
          }
          add.call(editor, {
            name: "log-trim-silent",
            description:
              "Silent fallback: trim opencode.log now (non-TUI clients; TUI uses /log-trim)",
            execute: async (_input?: {
              sessionID?: string;
            }): Promise<void> => {
              try {
                void _input;
                // Background trim work (fire-and-forget, never holds execute).
                // Fully silent: no progress or result messages.
                // Only persists TrimResult via storage.
                try {
                  const background = (async (): Promise<void> => {
                    try {
                      const opts = getOpts();
                      const logPath = safeLogPath(opts);
                      logTrimStart(logPath, opts);
                      let r: TrimResult;
                      try {
                        r = await Promise.race([
                          trimLog(opts),
                          new Promise<TrimResult>((_, reject) => {
                            setTimeout(
                              () => reject(new Error("timeout")),
                              30000,
                            );
                          }),
                        ]);
                        logTrimFinish(logPath, r);
                      } catch (err) {
                        try {
                          console.error(
                            `[opencode-log-trimmer] log-trim-silent timed out or failed for ${logPath}:`,
                            err,
                          );
                        } catch {
                          // Debug logs must never throw.
                        }
                        const isTimeout =
                          err instanceof Error && err.message === "timeout";
                        r = {
                          trimmed: false,
                          reason: isTimeout ? "error:timeout" : "error",
                          beforeBytes: 0,
                          afterBytes: 0,
                          beforeLines: 0,
                          afterLines: 0,
                        };
                        logTrimFinish(logPath, r);
                      }

                      // Tail-able status file (Option B observability).
                      // Fire-and-forget, never throws, never awaited.
                      try {
                        writeTrimStatus(r, "command", {
                          logPathOverride: opts.logPathOverride,
                        });
                      } catch {
                        // writeTrimStatus never throws; guard only.
                      }

                      // Persist lastTrim (fire-and-forget).
                      try {
                        const pendingStore = anyCtx?.storage?.set?.(
                          "lastTrim",
                          r,
                        ) as Promise<void> | undefined;
                        if (
                          pendingStore &&
                          typeof pendingStore.catch === "function"
                        ) {
                          void pendingStore.catch((err) => {
                            console.error(
                              "[opencode-log-trimmer] failed to persist lastTrim:",
                              err,
                            );
                          });
                        }
                      } catch (err) {
                        console.error(
                          "[opencode-log-trimmer] failed to persist lastTrim:",
                          err,
                        );
                      }
                    } catch (err) {
                      console.error(
                        "[opencode-log-trimmer] log-trim-silent execute failed:",
                        err,
                      );
                    }
                  })();
                  if (
                    background &&
                    typeof background.catch === "function"
                  ) {
                    void background.catch((err) => {
                      console.error(
                        "[opencode-log-trimmer] log-trim-silent execute failed:",
                        err,
                      );
                    });
                  }
                } catch (err) {
                  console.error(
                    "[opencode-log-trimmer] log-trim-silent execute failed:",
                    err,
                  );
                }
              } catch (err) {
                console.error(
                  "[opencode-log-trimmer] log-trim-silent execute failed:",
                  err,
                );
              }
            },
          });
        } catch (err) {
          console.error(
            "[opencode-log-trimmer] failed to register log-trim-silent command:",
            err,
          );
        }
      });
      if (
        maybePromise &&
        typeof (maybePromise as Promise<void>).catch === "function"
      ) {
        void (maybePromise as Promise<void>).catch((err) => {
          console.error(
            "[opencode-log-trimmer] command transform failed:",
            err,
          );
        });
      }
    } catch (err) {
      console.error(
        "[opencode-log-trimmer] command transform setup failed:",
        err,
      );
    }
  } catch (err) {
    console.error(
      "[opencode-log-trimmer] registerLogTrimCommand failed:",
      err,
    );
  }
}
