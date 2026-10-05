import { Rpc } from "@opencode/plugin";
import type { TrimOptions } from "./options.js";

export type TrimRpcInput = { optsOverride?: Partial<TrimOptions> } | void;

const TrimRpcInputSchema = {
  type: "object",
  properties: {
    optsOverride: {
      type: "object",
      properties: {
        maxSizeMB: { type: "number" },
        maxLines: { type: "number" },
        maxAgeDays: { type: "number" },
        intervalMs: { type: "number" },
        trimTargetRatio: { type: "number" },
        logPathOverride: { type: "string" },
        dryRun: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: true,
};

const TrimRpcOutputSchema = {
  type: "object",
  properties: {
    trimmed: { type: "boolean" },
    reason: { type: "string" },
    beforeBytes: { type: "number" },
    afterBytes: { type: "number" },
    beforeLines: { type: "number" },
    afterLines: { type: "number" },
  },
  required: [
    "trimmed",
    "reason",
    "beforeBytes",
    "afterBytes",
    "beforeLines",
    "afterLines",
  ],
  additionalProperties: false,
};

export const logTrimRpc = Rpc.define({
  id: "opencode-log-trimmer",
  methods: {
    trim: {
      input: TrimRpcInputSchema,
      output: TrimRpcOutputSchema,
    },
  },
  events: {},
});
