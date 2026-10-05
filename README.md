# opencode-log-trimmer

Periodic size + lines + age trimming of the global `opencode.log` via an OpenCode v2 server plugin.

## What it does

- Targets the global log file (see Windows path note below), not per-project logs.
- Runs as an OpenCode v2 server plugin (`Plugin.define`, id `opencode-log-trimmer`).
- **Trim-on-load:** runs one trim pass immediately on `setup()` (fire-and-forget, never throws to the host).
- **Interval:** arms `setInterval(30 min)` with `unref()` so it only runs while the opencode service is alive.
- **No daemon / no cron:** there is no background process, no cron dependency, and nothing survives after the service exits. Cleanup clears the interval on plugin unload.
- Enforces a **combination retention policy**: a trim pass satisfies ALL of `maxSizeMB` AND `maxLines` AND `maxAgeDays`, with the most restrictive limit winning. Kept content is always the most recent tail. Over-limit dimensions cut to `trimTargetRatio` x limit (hysteresis), so the next interval rarely re-trims.

## Retention options

| Option | Default | Meaning |
|---|---|---|
| `maxSizeMB` | `20` | Max log size in megabytes. Oversize output is reduced from the head so the tail (newest bytes) wins. |
| `maxLines` | `20000` | Max retained lines. Overflow keeps the newest `trimTargetRatio x maxLines` lines (hysteresis). |
| `maxAgeDays` | `14` | Max line age in days. Lines with a parseable timestamp older than `now - maxAgeDays` are dropped. A file `mtime` older than `maxAgeDays` alone is sufficient to trigger a trim pass. |
| `intervalMs` | `1800000` | Trim interval in ms (30 min). |
| `trimTargetRatio` | `0.5` | Hysteresis: when a trim triggers, over-limit dimensions are cut to this fraction of their limit (not the limit itself), so it takes time before the log is trimmable again. `(0, 1]`; values `> 1` clamp to `1` (old at-the-limit behavior). |
| `logPathOverride` | unset | Override the resolved log path (tests / custom locations). When unset, `resolveLogPath()` is used. |
| `dryRun` | unset | When `true`, strictly read-only: computes and reports `TrimResult` without writing any file. |

`TrimResult` reports `{ trimmed, reason, beforeBytes, afterBytes, beforeLines, afterLines }` with reasons such as `within-limits`, `missing`, `trimmed:size+lines+age`, or `dry-run:trimmed:...`.

## Install

Pick one:

1. **npm global (recommended):**

   ```sh
   opencode plugin add --global opencode-log-trimmer
   ```

2. **Global-dir copy:**

   Copy this package (or its built output) to the global plugin dir, e.g.:

   ```sh
   cp -r ./opencode-log-trimmer ~/.config/opencode/plugins/log-trimmer
   ```

3. **Project-local dev (this repo):**

   Use the dev harness shim at `.opencode/plugins/log-trimmer-dev.ts` (see Dev harness below). No install step; opencode loads it from the project.

## Config example

In your opencode config (`~/.config/opencode/opencode.json` or project `.opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-log-trimmer"
  ]
}
```

With custom retention (where supported by your opencode version — plugin options object):

```json
{
  "plugins": [
    "opencode-log-trimmer"
  ],
  "pluginOptions": {
    "opencode-log-trimmer": {
      "maxSizeMB": 20,
      "maxLines": 20000,
      "maxAgeDays": 14,
      "intervalMs": 1800000,
      "trimTargetRatio": 0.5
    }
  }
}
```

For a one-off dry run against a copy (no writes):

```ts
import { trimLog } from "./src/log-trimmer/index.js";

await trimLog({
  maxSizeMB: 20,
  maxLines: 20000,
  maxAgeDays: 14,
  intervalMs: 1800000,
  logPathOverride: "/tmp/opencode.log.copy",
  dryRun: true,
});
```

## Safety notes

- **Atomic scratch + rename:** trims rewrite via a sibling scratch file in the same log directory (`opencode.log.scratch-<pid>`) followed by atomic `rename`. Never deletes `opencode.log` outright and never truncates it in place.
- **Never delete:** a missing log returns `{ trimmed: false, reason: "missing" }`; an empty log stays empty. No unlink of the live log.
- **Scoped writes:** never touches files outside the resolved log directory. Scratch files do not use the forbidden `temp_` or `legacy_` filename prefixes.
- **Best-effort age:** age filtering parses leading `[ts]` / `(ts)` / ISO-like timestamps via `parseLogTimestamp()`. Lines with unparseable timestamps are **retained**; the size and lines limits still apply.
- **Race caveat:** the read-modify-rename cycle is not locked against a concurrent writer, so a line appended between read and rename can be lost (at most ~1 line window). No in-place corruption, but not lossless under active writes.
- **Windows path via homedir:** the default path is built with `os.homedir()` + `path.join(homedir, ".local", "share", "opencode", "log", "opencode.log")`, so it resolves correctly on Windows (e.g. `C:\Users\<you>\.local\share\opencode\log\opencode.log`) as well as POSIX. Pass `logPathOverride` to target any other file.
- **Host-safe:** `setup()` and interval callbacks never throw to the host; all failures degrade to a `TrimResult` with an `error:*` reason.

## Dev harness usage

`.opencode/plugins/log-trimmer-dev.ts` is a minimal local harness for project-local testing:

```ts
export { default } from "../../src/log-trimmer/index.js";
```

- Keep minimal: re-export only, no logic, no options handling.
- From `.opencode/plugins/` the relative path `../../src/log-trimmer/index.js` resolves to `src/log-trimmer/index.ts` at the repo root.
- Opencode loads this shim automatically for this project; edit `src/log-trimmer/*`, reload the service, and the trim-on-load pass exercises your change. Use `logPathOverride` + `dryRun: true` while iterating to avoid touching the real global log.
