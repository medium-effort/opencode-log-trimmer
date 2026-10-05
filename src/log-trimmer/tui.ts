import * as Plugin from "@opencode/plugin/tui/plugin";
import { logTrimRpc } from "./rpc.js";

export function formatTrimError(err: unknown): string {
  try {
    if (err instanceof Error) {
      const msg =
        typeof err.message === "string" && err.message.trim().length > 0
          ? err.message
          : null;
      if (msg) {
        return msg.length > 300 ? msg.slice(0, 300) : msg;
      }
      // Empty-message Error falls through to object handling below.
    }
    if (typeof err === "string") {
      if (err.trim().length === 0) {
        return "unknown error";
      }
      return err.length > 300 ? err.slice(0, 300) : err;
    }
    if (err !== null && typeof err === "object") {
      const rec = err as Record<string, unknown>;
      const parts: Array<string> = [];
      const rawMsg = rec["message"];
      if (typeof rawMsg === "string" && rawMsg.trim().length > 0) {
        parts.push(rawMsg.length > 300 ? rawMsg.slice(0, 300) : rawMsg);
      }
      const rawType = rec["type"];
      if (typeof rawType === "string" && rawType.trim().length > 0) {
        const t = rawType.length > 100 ? rawType.slice(0, 100) : rawType;
        if (parts.length > 0) {
          if (!parts[0].includes(t)) {
            parts.push(`[${t}]`);
          }
        } else {
          parts.push(t);
        }
      }
      if ("data" in rec) {
        try {
          const data = rec["data"];
          if (data !== undefined && data !== null) {
            let s: string | null = null;
            if (typeof data === "string") {
              s = data;
            } else {
              try {
                s = JSON.stringify(data);
              } catch {
                try {
                  s = String(data);
                } catch {
                  s = null;
                }
              }
            }
            if (
              typeof s === "string" &&
              s.length > 0 &&
              s !== "[object Object]" &&
              !s.includes("[object Object]")
            ) {
              parts.push(s.length > 300 ? s.slice(0, 300) : s);
            }
          }
        } catch {
          // Ignore data formatting failures.
        }
      }
      if (parts.length > 0) {
        const joined = parts.join(" ").trim();
        if (
          joined.length > 0 &&
          joined !== "[object Object]" &&
          !joined.includes("[object Object]")
        ) {
          return joined.length > 500 ? joined.slice(0, 500) : joined;
        }
      }
      try {
        const whole = JSON.stringify(rec);
        if (
          typeof whole === "string" &&
          whole.length > 0 &&
          whole !== "{}" &&
          whole !== "[object Object]" &&
          !whole.includes("[object Object]")
        ) {
          return whole.length > 300 ? whole.slice(0, 300) : whole;
        }
      } catch {
        // Ignore stringify failures.
      }
      return "unknown error";
    }
    try {
      const s = String(err);
      if (s === "[object Object]" || s === "[object]" || s.length === 0) {
        return "unknown error";
      }
      return s.length > 300 ? s.slice(0, 300) : s;
    } catch {
      return "unknown error";
    }
  } catch {
    return "unknown error";
  }
}

export const TRIM_UNAVAILABLE_HINT =
  "server opencode-log-trimmer unavailable — reload window / restart opencode to register the trim RPC, then retry";

export function isTrimUnavailable(err: unknown): boolean {
  try {
    if (typeof err === "string") {
      return err.toLowerCase().includes("unavailable");
    }
    if (err instanceof Error) {
      try {
        const msg = (err.message ?? "").toLowerCase();
        if (msg.includes("unavailable")) {
          return true;
        }
        const cause = (err as unknown as { cause?: unknown })?.cause;
        if (
          typeof cause === "string" &&
          cause.toLowerCase().includes("unavailable")
        ) {
          return true;
        }
      } catch {
        // Ignore inspection failures.
      }
      return false;
    }
    if (err !== null && typeof err === "object") {
      try {
        const rec = err as Record<string, unknown>;
        const parts: Array<string> = [];
        if (typeof rec["message"] === "string") {
          parts.push(rec["message"] as string);
        }
        if (typeof rec["type"] === "string") {
          parts.push(rec["type"] as string);
        }
        if ("data" in rec) {
          try {
            const d = rec["data"];
            if (typeof d === "string") {
              parts.push(d);
            } else if (d !== undefined && d !== null) {
              try {
                const s = JSON.stringify(d);
                if (typeof s === "string") {
                  parts.push(s);
                }
              } catch {
                // Ignore.
              }
            }
          } catch {
            // Ignore.
          }
        }
        try {
          const whole = JSON.stringify(rec);
          if (typeof whole === "string") {
            parts.push(whole);
          }
        } catch {
          // Ignore.
        }
        return parts.join(" ").toLowerCase().includes("unavailable");
      } catch {
        return false;
      }
    }
    try {
      return String(err).toLowerCase().includes("unavailable");
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function resolveTrimDirectory(ctx: unknown): string | undefined {
  try {
    const c = ctx as unknown as {
      location?: { directory?: unknown };
      data?: { location?: { default?: unknown } };
    };
    try {
      const direct = c?.location?.directory;
      if (typeof direct === "string" && direct.length > 0) {
        return direct;
      }
    } catch {
      // Ignore direct lookup failures, try the fallback.
    }
    try {
      const def = (c as any)?.data?.location?.default;
      if (typeof def === "function") {
        const ref = (c as any).data.location.default()?.directory;
        if (typeof ref === "string" && ref.length > 0) {
          return ref;
        }
      }
    } catch {
      // Ignore fallback lookup failures.
    }
  } catch {
    // Never throw to the host.
  }
  return undefined;
}

function buildTrimRpcOptions(
  directory: string | undefined,
):
  | { location: { directory: string }; headers: Record<string, string> }
  | undefined {
  try {
    if (typeof directory !== "string" || directory.length === 0) {
      return undefined;
    }
    return {
      location: { directory },
      headers: { "x-opencode-directory": directory },
    };
  } catch {
    return undefined;
  }
}

export const tuiPlugin = Plugin.define({
  id: "opencode-log-trimmer-tui",
  setup(ctx) {
    try {
      console.log("[opencode-log-trimmer] tui setup loaded");
    } catch {
      // Never throw to the host.
    }
    try {
      (ctx as any)?.ui?.slot({
        append: "app",
        render: () => {
          try {
            (ctx as any)?.keymap?.layer(() => ({
              mode: "global",
              commands: [
                {
                  id: "log-trimmer.trim",
                  title: "Trim opencode.log",
                  description: "Manually trim opencode.log now",
                  palette: true,
                  slash: { name: "log-trim" },
                  run: async () => {
                    try {
                      try {
                        ctx.ui.toast.show({
                          message: "Trim started",
                          variant: "info",
                        });
                      } catch {
                        // Never throw from toast.
                      }
                      try {
                        const api = ctx.client.rpc(
                          logTrimRpc,
                        ) as unknown as {
                          trim: (
                            input: {},
                            options?: {
                              location?: { directory?: string };
                              headers?: Record<string, string>;
                            },
                          ) => Promise<{
                            trimmed?: unknown;
                            reason?: unknown;
                            beforeBytes?: unknown;
                            afterBytes?: unknown;
                            beforeLines?: unknown;
                            afterLines?: unknown;
                          }>;
                        };
                        const directory = resolveTrimDirectory(ctx);
                        const rpcOptions = buildTrimRpcOptions(directory);
                        const callTrim = () =>
                          rpcOptions !== undefined
                            ? api.trim({}, rpcOptions)
                            : api.trim({});
                        let res: {
                          trimmed?: unknown;
                          reason?: unknown;
                          beforeBytes?: unknown;
                          afterBytes?: unknown;
                          beforeLines?: unknown;
                          afterLines?: unknown;
                        };
                        try {
                          res = await callTrim();
                        } catch (firstErr) {
                          // Single retry for the startup race: the TUI can
                          // mount before the server registers the trim RPC.
                          // Location routing covers BOTH channels with the
                          // SAME second-arg options on the retry.
                          if (!isTrimUnavailable(firstErr)) {
                            throw firstErr;
                          }
                          try {
                            await new Promise<void>((resolve) => {
                              setTimeout(() => resolve(), 2000);
                            });
                          } catch {
                            // Timer must never throw.
                          }
                          res = await callTrim();
                        }
                        const trimmed = (res as any)?.trimmed === true;
                        const reason =
                          typeof (res as any)?.reason === "string"
                            ? ((res as any).reason as string)
                            : "ok";
                        const beforeBytes =
                          typeof (res as any)?.beforeBytes === "number"
                            ? ((res as any).beforeBytes as number)
                            : undefined;
                        const afterBytes =
                          typeof (res as any)?.afterBytes === "number"
                            ? ((res as any).afterBytes as number)
                            : undefined;
                        const beforeLines =
                          typeof (res as any)?.beforeLines === "number"
                            ? ((res as any).beforeLines as number)
                            : undefined;
                        const afterLines =
                          typeof (res as any)?.afterLines === "number"
                            ? ((res as any).afterLines as number)
                            : undefined;
                        const budget =
                          beforeBytes !== undefined && afterBytes !== undefined
                            ? ` ${(beforeBytes / 1048576).toFixed(2)}MB->${(afterBytes / 1048576).toFixed(2)}MB`
                            : "";
                        const lines =
                          beforeLines !== undefined && afterLines !== undefined
                            ? ` ${beforeLines}->${afterLines} lines`
                            : "";
                        try {
                          ctx.ui.toast.show({
                            message: trimmed
                              ? `Trim done:${budget}${lines} ${reason}`
                              : `Trim skipped:${budget}${lines} ${reason}`,
                            variant: trimmed ? "success" : "info",
                          });
                        } catch {
                          // Never throw from toast.
                        }
                      } catch (err) {
                        try {
                          const detail = formatTrimError(err);
                          const hint = isTrimUnavailable(err)
                            ? ` ${TRIM_UNAVAILABLE_HINT}`
                            : "";
                          ctx.ui.toast.show({
                            message: `Trim failed: ${detail}${hint}`,
                            variant: "error",
                          });
                        } catch {
                          // Never throw from toast.
                        }
                      }
                    } catch {
                      // Never throw to the host.
                    }
                  },
                },
              ],
            }));
          } catch {
            // Never throw from slot render to the host.
          }
          return null as any;
        },
      });
    } catch {
      // Never throw to the host.
    }
  },
});

export default tuiPlugin;
