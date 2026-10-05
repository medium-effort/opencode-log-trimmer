export function parseLogTimestamp(line: string): number | null {
  try {
    if (typeof line !== "string" || line.length === 0) {
      return null;
    }
    const trimmed = line.trimStart();
    if (trimmed.length === 0) {
      return null;
    }

    // Bracketed leading timestamp: "[<ts>] rest" or "(<ts>) rest".
    const first = trimmed[0];
    if (first === "[" || first === "(") {
      const closer = first === "[" ? "]" : ")";
      const end = trimmed.indexOf(closer);
      if (end > 1) {
        const candidate = trimmed.slice(1, end).trim();
        if (candidate.length > 0) {
          const parsed = Date.parse(candidate);
          if (!Number.isNaN(parsed)) {
            return parsed;
          }
        }
      }
    }

    // Leading ISO-like timestamp: YYYY-MM-DD[T| ]HH:MM[:SS[.ms]][Z|±HH:?MM].
    const isoMatch =
      /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(
        trimmed,
      );
    if (isoMatch) {
      const parsed = Date.parse(isoMatch[1]);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    // Fallback: best-effort Date.parse over a leading slice so
    // timestamps with slight format drift still resolve.
    const head = trimmed.slice(0, 35);
    const fallback = Date.parse(head);
    if (!Number.isNaN(fallback)) {
      return fallback;
    }
    const firstTwoTokens = trimmed.split(" ", 3).slice(0, 2).join(" ");
    if (firstTwoTokens.length > 0 && firstTwoTokens !== head) {
      const reparsed = Date.parse(firstTwoTokens);
      if (!Number.isNaN(reparsed)) {
        return reparsed;
      }
    }
    return null;
  } catch {
    return null;
  }
}
