# fix-8fe13adfd8aa78ca — Callback query never answered when sealDraft/KMS throws in E1 mode-selection handlers

**Weight:** 0.0000 (share of project budget)
**Reward:** 0 EPTX

In `src/bot.ts:338-389`, the `callback_query:data` handler's `ctx.answerCallbackQuery()` call at line 388 is unreachable if any branch throws an error. When a user taps a mode button (`upload:mode:first-read`, `upload:mode:time-limited`, `upload:ttl:*`), `sealDraft` is called, which performs async KMS key wrapping and message storage. If any of these fail (e.g., `kms.wrap` throws), the exception propagates past `ctx.answerCallbackQuery()`. The `bot.catch` boundary at line 434 catches the error and replies with a new generic error message, but the callback query itself is never answered. The Telegram client shows a loading spinner that persists until its client-side timeout expires, degrading UX for failed uploads.

**Fix:** Move `ctx.answerCallbackQuery()` into a `finally` block or into the `bot.catch` handler, or use grammY's per-middleware error handler to ensure the callback query is always answered regardless of success or failure.

## Dialog tests

This is a FIX task: the behavior it repairs is already covered by an existing spec under `tests/specs/`. Fix the code to make that existing spec pass — do NOT author a new `tests/specs/fix-8fe13adfd8aa78ca.json` (a duplicate spec for the same behavior makes the tests-gate count it twice and it can never go green). Add a new spec file ONLY if you are introducing genuinely new user-facing behavior that no existing spec covers; if so, name it `tests/specs/fix-8fe13adfd8aa78ca.json` (and any new command `tests/commands/fix-8fe13adfd8aa78ca.json`).


## Handler module

This is a FIX task. Find the EXISTING handler under `src/handlers/` that implements the affected command/behavior and EDIT it in place. Do NOT create a new `src/handlers/fix-8fe13adfd8aa78ca.ts` — a second `Composer` binding the same command conflicts with the original and breaks the bot. Create a new handler file ONLY if the affected command does not exist anywhere yet (then name it `src/handlers/fix-8fe13adfd8aa78ca.ts` and default-export a grammY `Composer`; `buildBot()` auto-loads it). NEVER edit `src/bot.ts`; the global error boundary + unknown-command fallback already live in `buildBot()`.


## Implementation contract

Ship a COMPLETE, working implementation — not a stub. A task is INCOMPLETE (and will be rejected) even if it compiles and the dialog tests pass when it does any of these:
- **Stubbed code:** empty bodies, `TODO`/`FIXME`, commented-out logic, or `throw new Error("not implemented")`.
- **Fabricated data:** `Math.random()`, hardcoded sample arrays, or canned responses standing in for real computed or fetched values.
- **No in-memory data store:** a `Map`/array/module-level variable used as a database is a defect. Anything that must survive a restart (records, subscriptions, balances, schedules, settings) MUST use the toolkit's persistent storage (Redis-backed), not process memory. (The toolkit's auto-selected session storage is only for ephemeral conversation state.)
- **Broken integrations:** call external APIs against their real contract — correct endpoints, ids and params (e.g. a coin *id* like `the-open-network`, not a ticker like `TON`) — with credentials read from env. Do not invent endpoints or fake responses.
- **Dead code:** the feature's command/handler must be registered via its default-exported `Composer` in `src/handlers/<slug>.ts` (auto-loaded) and reachable from the bot's command surface.
If the spec is genuinely under-specified, implement the smallest REAL slice you can verify and note the gap — never fake behavior to make the PR look complete.
