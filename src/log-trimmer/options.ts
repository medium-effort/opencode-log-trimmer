export interface TrimOptions {
  maxSizeMB: number;
  maxLines: number;
  maxAgeDays: number;
  intervalMs: number;
  logPathOverride?: string;
  dryRun?: boolean;
}

export interface TrimResult {
  trimmed: boolean;
  reason: string;
  beforeBytes: number;
  afterBytes: number;
  beforeLines: number;
  afterLines: number;
}

export const DEFAULT_OPTIONS: TrimOptions = {
  maxSizeMB: 20,
  maxLines: 20000,
  maxAgeDays: 14,
  intervalMs: 1800000,
};

export function resolveOptions(partial?: Partial<TrimOptions>): TrimOptions {
  try {
    if (!partial) {
      return { ...DEFAULT_OPTIONS };
    }
    return {
      maxSizeMB: partial.maxSizeMB ?? DEFAULT_OPTIONS.maxSizeMB,
      maxLines: partial.maxLines ?? DEFAULT_OPTIONS.maxLines,
      maxAgeDays: partial.maxAgeDays ?? DEFAULT_OPTIONS.maxAgeDays,
      intervalMs: partial.intervalMs ?? DEFAULT_OPTIONS.intervalMs,
      ...(partial.logPathOverride !== undefined
        ? { logPathOverride: partial.logPathOverride }
        : {}),
      ...(partial.dryRun !== undefined ? { dryRun: partial.dryRun } : {}),
    };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}
