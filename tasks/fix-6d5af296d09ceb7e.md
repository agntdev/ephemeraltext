# fix-6d5af296d09ceb7e — First-read one-time-view has a race condition allowing multiple reads

**Weight:** 0.0000 (share of project budget)
**Reward:** 0 EPTX

In `retrieval.ts:46-49`, the first-read expiry uses a non-atomic `load` → decrypt → `delete` sequence. Two concurrent requests can both `load` the message (line 27) before either calls `store.delete` (line 49). Both will decrypt and return the plaintext, violating the guarantee that the message is readable exactly once.  
With a Redis-backed store behind multiple bot instances, this race is exploitable. A fix would use an atomic check-and-delete (e.g. Redis `GET`+`DEL` in a pipeline, or a Lua script) at the storage layer instead of the current read-then-delete pattern.

## Dialog tests

This is a FIX task: the behavior it repairs is already covered by an existing spec under `tests/specs/`. Fix the code to make that existing spec pass — do NOT author a new `tests/specs/fix-6d5af296d09ceb7e.json` (a duplicate spec for the same behavior makes the tests-gate count it twice and it can never go green). Add a new spec file ONLY if you are introducing genuinely new user-facing behavior that no existing spec covers; if so, name it `tests/specs/fix-6d5af296d09ceb7e.json` (and any new command `tests/commands/fix-6d5af296d09ceb7e.json`).


## Handler module

This is a FIX task. Find the EXISTING handler under `src/handlers/` that implements the affected command/behavior and EDIT it in place. Do NOT create a new `src/handlers/fix-6d5af296d09ceb7e.ts` — a second `Composer` binding the same command conflicts with the original and breaks the bot. Create a new handler file ONLY if the affected command does not exist anywhere yet (then name it `src/handlers/fix-6d5af296d09ceb7e.ts` and default-export a grammY `Composer`; `buildBot()` auto-loads it). NEVER edit `src/bot.ts`; the global error boundary + unknown-command fallback already live in `buildBot()`.


## Implementation contract

Ship a COMPLETE, working implementation — not a stub. A task is INCOMPLETE (and will be rejected) even if it compiles and the dialog tests pass when it does any of these:
- **Stubbed code:** empty bodies, `TODO`/`FIXME`, commented-out logic, or `throw new Error("not implemented")`.
- **Fabricated data:** `Math.random()`, hardcoded sample arrays, or canned responses standing in for real computed or fetched values.
- **No in-memory data store:** a `Map`/array/module-level variable used as a database is a defect. Anything that must survive a restart (records, subscriptions, balances, schedules, settings) MUST use the toolkit's persistent storage (Redis-backed), not process memory. (The toolkit's auto-selected session storage is only for ephemeral conversation state.)
- **Broken integrations:** call external APIs against their real contract — correct endpoints, ids and params (e.g. a coin *id* like `the-open-network`, not a ticker like `TON`) — with credentials read from env. Do not invent endpoints or fake responses.
- **Dead code:** the feature's command/handler must be registered via its default-exported `Composer` in `src/handlers/<slug>.ts` (auto-loaded) and reachable from the bot's command surface.
If the spec is genuinely under-specified, implement the smallest REAL slice you can verify and note the gap — never fake behavior to make the PR look complete.
