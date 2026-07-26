import type { ExecutionStatus } from "./types";

// The one color mapping every execution-status display shares — extracted
// so ExecutionStatusCard, ActivityFeed, and AttentionPanel don't each
// redefine it. Status *labels* stay local to each component instead: a
// connection card wants "Connected"/"Needs attention", while a feed of
// mixed action types (store edits, product changes, Genesis turns) reads
// better from each row's own `message` than a repeated generic word.
export const STATUS_DOT: Record<ExecutionStatus, string> = {
  SUCCESS: "bg-green-500",
  WARNING: "bg-yellow-500",
  FAILED: "bg-red-500",
  PENDING: "bg-zinc-400",
  PARTIAL: "bg-orange-500",
};
