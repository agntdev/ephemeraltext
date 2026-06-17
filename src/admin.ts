// Admin authorization. The set of admin Telegram user ids is configured via the
// ADMIN_IDS env var (comma-separated). With none configured, nobody is an admin —
// a secure default (the /admin surface is closed rather than open).

function adminIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** True if the given Telegram user id is an authorized admin. */
export function isAdmin(id: number | undefined): boolean {
  if (id === undefined) return false;
  return adminIds().has(String(id));
}
