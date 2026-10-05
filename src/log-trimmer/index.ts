import { Plugin } from "@opencode/plugin";
import { logTrimRpc } from "./rpc.js";
import { registerLogTrimCommand } from "./command.js";
import { resolveOptions } from "./options.js";
import type { TrimOptions, TrimResult } from "./options.js";
import { resolveLogPath } from "./path.js";
import { trimLog } from "./trim.js";
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

export default Plugin.define({
  id: "opencode-log-trimmer",
  async setup(ctx) {
    try {
      let resolvedOpts;
      try {
        resolvedOpts =
          resolveOptions(
            (ctx?.options as Parameters<typeof resolveOptions>[0]) ?? {},
          );
      } catch (err) {
        console.error(
          "[opencode-log-trimmer] failed to resolve options, using defaults:",
          err,
        );
        resolvedOpts = resolveOptions({});
      }

      const intervalMs =
        typeof resolvedOpts.intervalMs === "number" &&
        Number.isFinite(resolvedOpts.intervalMs) &&
        resolvedOpts.intervalMs > 0
          ? resolvedOpts.intervalMs
          : 1800000;

      // Slash command registration (never throws to the host).
      // Silent fallback is always kept even if RPC registration fails.
      try {
        registerLogTrimCommand(ctx, () => resolvedOpts);
      } catch (err) {
        console.error(
          "[opencode-log-trimmer] failed to register log-trim-silent command:",
          err,
        );
      }

      const persist = (res: unknown): void => {
        try {
          const pending = (
            ctx as unknown as {
              storage?: {
                set?: (key: string, value: never) => Promise<void>;
              };
            }
          )?.storage?.set?.("lastTrim", res as never) as
            | Promise<void>
            | undefined;
          if (
            pending &&
            typeof (pending as Promise<void>).catch === "function"
          ) {
            void (pending as Promise<void>).catch((err) => {
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
      };

      // Shared trim RPC (static import, direct register; loud on skip, never throws).
      try {
        const rpcHost = (ctx as unknown as { rpc?: unknown })?.rpc as
          | { register?: unknown }
          | undefined;
        const register = (rpcHost as { register?: unknown } | undefined)
          ?.register as
          | ((...args: unknown[]) => unknown)
          | undefined;
        if (typeof register !== "function" || !rpcHost) {
          try {
            let hostKeys = "unknown";
            try {
              const c = ctx as unknown as Record<string, unknown> | null | undefined;
              if (c && typeof c === "object") {
                const keys = Object.keys(c);
                hostKeys =
                  keys.length > 0 ? keys.join(",") : "(no keys)";
              } else {
                hostKeys = String(typeof ctx);
              }
            } catch {
              // Keep hostKeys as unknown.
            }
            console.error(
              `[opencode-log-trimmer] rpc registration skipped: ctx.rpc missing for id=opencode-log-trimmer hostKeys=${hostKeys} (server plugin opencode-log-trimmer not hosting RPC; reload window / restart opencode)`,
            );
          } catch {
            // Never throw.
          }
        } else {
          const handler = async (
            input?: unknown,
          ): Promise<TrimResult> => {
            try {
              let merged = resolvedOpts;
              try {
                const override = (
                  input as { optsOverride?: unknown } | null | undefined
                )?.optsOverride;
                if (override && typeof override === "object") {
                  merged = resolveOptions({
                    ...resolvedOpts,
                    ...(override as Partial<TrimOptions>),
                  });
                }
              } catch {
                // Keep resolvedOpts on bad override.
              }
              const rpcPath = safeLogPath(merged);
              logTrimStart(rpcPath, merged);
              let result: TrimResult;
              try {
                result = await Promise.race([
                  trimLog(merged),
                  new Promise<TrimResult>((_, reject) => {
                    setTimeout(
                      () => reject(new Error("timeout")),
                      30000,
                    );
                  }),
                ]);
                logTrimFinish(rpcPath, result);
              } catch (err) {
                try {
                  console.error(
                    `[opencode-log-trimmer] rpc trim timed out or failed for ${rpcPath}:`,
                    err,
                  );
                } catch {
                  // Debug logs must never throw.
                }
                const isTimeout =
                  err instanceof Error && err.message === "timeout";
                result = {
                  trimmed: false,
                  reason: isTimeout ? "error:timeout" : "error",
                  beforeBytes: 0,
                  afterBytes: 0,
                  beforeLines: 0,
                  afterLines: 0,
                };
                logTrimFinish(rpcPath, result);
              }
              try {
                writeTrimStatus(result, "rpc", {
                  logPathOverride: merged.logPathOverride,
                });
              } catch {
                // writeTrimStatus never throws; guard only.
              }
              try {
                persist(result);
              } catch {
                // persist() already logs internally; never throw.
              }
              return result;
            } catch (err) {
              try {
                console.error(
                  "[opencode-log-trimmer] rpc trim failed:",
                  err,
                );
              } catch {
                // Never throw to the host.
              }
              const failed: TrimResult = {
                trimmed: false,
                reason: "error",
                beforeBytes: 0,
                afterBytes: 0,
                beforeLines: 0,
                afterLines: 0,
              };
              try {
                writeTrimStatus(failed, "rpc", {
                  logPathOverride: resolvedOpts.logPathOverride,
                });
              } catch {
                // writeTrimStatus never throws; guard only.
              }
              return failed;
            }
          };
          try {
            await (register as (...a: unknown[]) => unknown).call(
              rpcHost,
              logTrimRpc,
              { trim: handler },
            );
            try {
              console.log("[opencode-log-trimmer] rpc trim registered");
            } catch {
              // Never throw.
            }
          } catch (err) {
            try {
              console.error(
                "[opencode-log-trimmer] rpc trim register failed:",
                err,
              );
            } catch {
              // Never throw.
            }
          }
        }
      } catch (err) {
        try {
          console.error("[opencode-log-trimmer] rpc setup failed:", err);
        } catch {
          // Never throw.
        }
      }

      // Trim-on-load (fire-and-forget, never throws) with debug prints.
      try {
        const loadPath = resolveLogPath(resolvedOpts.logPathOverride);
        logTrimStart(loadPath, resolvedOpts);
        void trimLog(resolvedOpts)
          .then((res) => {
            logTrimFinish(loadPath, res);
            try {
              writeTrimStatus(res, "trim-on-load", {
                logPathOverride: resolvedOpts.logPathOverride,
              });
            } catch {
              // writeTrimStatus never throws; guard only.
            }
            persist(res);
          })
          .catch((err) => {
            console.error(
              `[opencode-log-trimmer] trim-on-load failed for ${loadPath}:`,
              err,
            );
          });
      } catch (err) {
        console.error(
          "[opencode-log-trimmer] trim-on-load setup failed:",
          err,
        );
      }

      let timer: ReturnType<typeof setInterval>;
      try {
        timer = setInterval(() => {
          try {
            const logPath = resolveLogPath(resolvedOpts.logPathOverride);
            logTrimStart(logPath, resolvedOpts);
            void trimLog(resolvedOpts)
              .then((res) => {
                logTrimFinish(logPath, res);
                try {
                  writeTrimStatus(res, "interval", {
                    logPathOverride: resolvedOpts.logPathOverride,
                  });
                } catch {
                  // writeTrimStatus never throws; guard only.
                }
                persist(res);
              })
              .catch((err) => {
                console.error(
                  `[opencode-log-trimmer] interval trim failed for ${logPath}:`,
                  err,
                );
              });
          } catch (err) {
            try {
              const logPath = resolveLogPath(resolvedOpts.logPathOverride);
              console.error(
                `[opencode-log-trimmer] interval trim failed for ${logPath}:`,
                err,
              );
            } catch {
              console.error(
                "[opencode-log-trimmer] interval trim failed:",
                err,
              );
            }
          }
        }, intervalMs);
      } catch (err) {
        console.error(
          "[opencode-log-trimmer] failed to arm trim interval:",
          err,
        );
        return () => {};
      }

      try {
        (
          timer as unknown as { unref?: () => void }
        )?.unref?.();
      } catch (err) {
        console.error("[opencode-log-trimmer] timer unref failed:", err);
      }

      return () => {
        try {
          clearInterval(timer);
        } catch (err) {
          console.error(
            "[opencode-log-trimmer] failed to clear trim interval:",
            err,
          );
        }
      };
    } catch (err) {
      console.error("[opencode-log-trimmer] setup failed:", err);
      return () => {};
    }
  },
});
