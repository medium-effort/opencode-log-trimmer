import os from "os";
import path from "path";

export function resolveLogPath(overridePath?: string): string {
  try {
    if (typeof overridePath === "string" && overridePath.length > 0) {
      return overridePath;
    }
    return path.join(
      os.homedir(),
      ".local",
      "share",
      "opencode",
      "log",
      "opencode.log",
    );
  } catch {
    return path.join(
      os.homedir(),
      ".local",
      "share",
      "opencode",
      "log",
      "opencode.log",
    );
  }
}
