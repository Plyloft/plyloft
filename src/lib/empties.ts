// Module-scoped frozen empties for zustand selector `?? EMPTY_*` fallbacks.
// Returning a fresh `[]` / `{}` from a selector breaks zustand's Object.is
// identity check and triggers an infinite re-render loop (React #185); see
// docs/PATTERNS.md.
//
// `never[]` is a subtype of every `T[]`, and `Record<string, never>` is
// assignable to every `Record<string, V>`, so these two singletons substitute
// for typed per-file empties without per-consumer re-exports.

export const EMPTY_ARRAY: never[] = Object.freeze([]) as never[];
export const EMPTY_OBJECT: Record<string, never> = Object.freeze({}) as Record<string, never>;
