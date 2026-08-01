"use client";

// Genesis's real, live conversational activity — orthogonal to GenesisState
// (lib/dashboard/genesisState.ts), the same way the old isWorking overlay
// was documented as "a separate, additive... never suppresses or replaces
// the real assessment glow below." isWorking (useFormStatus().pending) is
// only real *inside* GenesisAssistant.tsx's own <form> — this module-level
// store is how that real value reaches GenesisAvatar instances elsewhere in
// the tree (GenesisDomicile, MobileGenesisPresence) without prop drilling
// or a Context provider. Same idiom GenesisAssistant.tsx already uses for
// itself (subscribeToDesktopWidth/getIsDesktopSnapshot) via
// useSyncExternalStore, just factored out so more than one component can
// publish/subscribe to it.
export interface GenesisActivitySnapshot {
  isWorking: boolean;
  isComposing: boolean;
}

let snapshot: GenesisActivitySnapshot = { isWorking: false, isComposing: false };
const listeners = new Set<() => void>();

function commit(next: GenesisActivitySnapshot) {
  if (next.isWorking === snapshot.isWorking && next.isComposing === snapshot.isComposing) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function setGenesisWorking(isWorking: boolean): void {
  commit({ ...snapshot, isWorking });
}

export function setGenesisComposing(isComposing: boolean): void {
  commit({ ...snapshot, isComposing });
}

export function subscribeGenesisActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGenesisActivitySnapshot(): GenesisActivitySnapshot {
  return snapshot;
}

// A real chat request in flight is never invisible during SSR (there is no
// SSR chat request) — always {false, false} server-side, matching every
// other hydration-safe read in this codebase.
const SERVER_SNAPSHOT: GenesisActivitySnapshot = { isWorking: false, isComposing: false };
export function getGenesisActivityServerSnapshot(): GenesisActivitySnapshot {
  return SERVER_SNAPSHOT;
}

export type GenesisActivityState = "idle" | "listening" | "thinking";

// isWorking outranks isComposing — a real request in flight is a stronger
// signal than "still has focus on the textarea" (matches Sean's own
// priority: Thinking triggers "while isWorking == true", full stop).
export function deriveActivityState({ isWorking, isComposing }: GenesisActivitySnapshot): GenesisActivityState {
  if (isWorking) return "thinking";
  if (isComposing) return "listening";
  return "idle";
}
