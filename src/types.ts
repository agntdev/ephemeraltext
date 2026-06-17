// Shared domain types used across modules (kept separate to avoid import cycles).

// How an ephemeral message expires once it is shared.
export type ExpiryMode = "first-read" | "time-limited";
