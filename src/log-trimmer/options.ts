export interface TrimOptions {
  maxSizeMB: number;
  maxLines: number;
  maxAgeDays: number;
  intervalMs: number;
  logPathOverride?: string;
  dryRun?: boolean;
  /** Hysteresis: over-limit dimensions trim to this fraction of their limit. (0, 1], default 0.5. */
  trimTargetRatio: number;
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
  trimTargetRatio: 0.5,
};

export function resolveTrimTargetRatio(input: unknown): number {
  try {
    if (typeof input !== "number" || !Number.isFinite(input)) {
      return DEFAULT_OPTIONS.trimTargetRatio;
    }
    if (input <= 0) {
      return DEFAULT_OPTIONS.trimTargetRatio;
    }
    if (input > 1) {
      return 1;
    }
    return input;
  } catch {
    return DEFAULT_OPTIONS.trimTargetRatio;
  }
}

export function resolveTrimTargets(opts: TrimOptions): { targetLines: number; targetBytes: number } {
  try {
    const ratio = resolveTrimTargetRatio(opts.trimTargetRatio);
    const maxBytes = Math.floor(opts.maxSizeMB * 1024 * 1024);
    const targetLines =
      opts.maxLines <= 0 ? 0 : Math.max(1, Math.floor(opts.maxLines * ratio));
    const targetBytes =
      maxBytes <= 0 ? 0 : Math.max(1, Math.floor(maxBytes * ratio));
    return { targetLines, targetBytes };
  } catch {
    return {
      targetLines: opts.maxLines,
      targetBytes: Math.floor(opts.maxSizeMB * 1024 * 1024),
    };
  }
}

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
      trimTargetRatio: resolveTrimTargetRatio(partial.trimTargetRatio),
      ...(partial.logPathOverride !== undefined
        ? { logPathOverride: partial.logPathOverride }
        : {}),
      ...(partial.dryRun !== undefined ? { dryRun: partial.dryRun } : {}),
    };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}
