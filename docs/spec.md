# EphemeralTextBot — Refined build brief

## Summary
A Telegram bot that lets anyone anonymously upload a text message via Telegram; the bot responds with an encrypted, expiring shareable URL. Recipients open the URL on a read-only website to view the message. Each message is stored encrypted on the server (service-managed keys). Sender chooses expiration per upload: "first-read" (self-destructs after the first successful view) or a time-based expiry up to 7 days.

## Audience
- People who need to share sensitive text once or for a short period without creating accounts.
- Recipients who receive a link and open it in a browser to read the message.

## Core entities
- Message
  - id (internal DB UUID)
  - public_token (URL-safe random token used in the shareable link)
  - encrypted_payload (ciphertext; server-side encryption)
  - mode ("first_read" or "time_limited")
  - expires_at (timestamp; for time_limited) or null
  - created_at
  - read_at (timestamp; null until read)
  - read_count (integer)
  - size_bytes (original plaintext size)
  - metadata (store minimal metadata for operations: e.g., encrypted filename if any — here only text so not used)
- UploadRequest (temporary runtime object for validation and rate-limiting)
- Audit log (admin-only): message id, public_token hash, created_at, deleted_at, action, operator

## Integrations & notification targets
- Telegram Bot API: receive messages from senders and reply with generated shareable URL or an error. Bot will support the /start and upload-by-text flow.
- Web frontend (read-only): route /r/<token> that decrypts and shows the message (or a notice that it expired or was already read).
- Key management: use a cloud KMS (AWS KMS recommended) or an application key-encryption key (default local key if KMS not available) to encrypt message encryption keys.
- Optional admin dashboard (internal) for moderation and viewing audit logs — not exposed to senders/recipients.

## Interaction flows
1) Sender (Telegram)
   - User opens Telegram bot and sends text (or /start then paste text).
   - Bot validates text size and mode choice (bot will prompt: "first-read" or "time-limited" and for time-limited ask for expiry duration up to 7 days).
   - Bot enforces rate limits and content policy checks (basic spam heuristics); if OK, create Message record, encrypt payload, persist, and return short shareable link: https://example.com/r/<public_token>.
   - Bot replies with the link and short usage notes (e.g., expiry and whether it self-destructs on first view).

2) Recipient (Browser)
   - Open link /r/<token>.
   - Server validates token, checks expiry/read status, decrypts payload in memory, and renders a simple page with the plaintext.
   - If mode == "first_read": mark read_at, increment read_count, and schedule immediate secure deletion of ciphertext (or zero it and remove DB record) after serving the page; the page shows a one-time-view notice.
   - If mode == "time_limited": keep accessible until expires_at; each view increments read_count but message remains until expires_at.
   - Expired or already-read tokens render a friendly expired/invalid page (no message content returned).

3) Admin/moderation
   - Admins can search logs, forcibly delete a message, or view usage metrics. Admin actions are audited.

## Persistence
- Primary database: store message metadata and encrypted_payload (Postgres or similar). The encrypted payload is opaque ciphertext.
- Encryption keys: message payloads encrypted with a per-message data key; data keys are encrypted by a master KMS key.
- Retention: messages purged automatically after expiry or after first read (depending on mode). Soft-delete grace window of a few minutes may be kept to allow audit; eventually overwritten or permanently removed during scheduled maintenance.
- Logging: minimal audit logs for moderation and abuse handling. Do not store plaintext in logs.

## Security & privacy
- Server-side encryption: AES-256-GCM (or equivalent) for payloads; keys managed by KMS by default.
- Public tokens are high-entropy, unguessable, URL-safe (recommend 128–192 bits of entropy, encoded base62 or base64url without padding).
- Sender anonymity: no account is created; sender-visible identity is not published with the message.
- Abuse mitigation: rate limits applied per Telegram sender ID (see Assumptions & defaults). Telegram sender IDs are recorded only as a non-reversible hash (HMAC with server key) for rate-limiting and abuse investigations — not reversible to preserve anonymity.
- No plaintext stored except transiently in server memory while rendering; access controls and audit logging restrict admin operations.
- HTTPS required for the web frontend.

## Payments
- None in scope. No paid features.

## Non-goals
- End-to-end (client-side) encryption or passphrase sharing — server manages keys.
- File attachments, images, or other media — text-only service.
- User accounts for senders — anonymous, one-time uploads only.
- Email or SMS delivery of messages.

## Operational details
- Link format: https://{host}/r/{public_token}
- public_token length: default 22 URL-safe chars (~132 bits entropy).
- Max message length: default 10,000 characters (reject larger uploads with an error message suggesting alternatives).
- Max time expiry: 7 days (owner specified).
- Rate limits: default 10 uploads/hour per Telegram sender (hashed ID used for enforcement). Excess returns a clear rate-limit message.
- Bot replies: immediate Telegram message containing the shareable URL and brief expiry information.
- First-read semantics: treat a successful HTTP 200 page render to a normal browser as the read event; API clients or prefetchers could trigger reads — mitigate with simple bot-detection heuristics (e.g., require a short JavaScript-enabled confirmation button on the read page for first-read mode). If JS is disabled the page still works but first-read still counts.

## Admin & moderation
- Admin interface protected by multi-factor auth (out of scope to implement in first iteration, but required for production).
- Admin actions (delete, view logs) are fully audited.

## Assumptions & defaults
- Anonymous uploads: we will not create persistent accounts for senders; rationale: meets "one-time upload" requirement and minimizes friction.
- Rate-limiting uses hashed Telegram sender IDs: rationale — protects sender anonymity while enabling abuse control; Telegram IDs are HMAC-hashed with a server key and kept only for rate-limiting/audit.
- Max message size = 10,000 chars: rationale — balances practical message sizes and storage/abuse concerns. Can be adjusted later.
- Token entropy = ~132 bits (22 URL-safe chars): rationale — unguessable links to rely on link secrecy rather than authentication.
- KMS for key management by default (AWS KMS recommended); if unavailable, a local master key stored securely will be used: rationale — production-grade key management is required to protect stored messages.
- First-read confirmation requires a small JS click to avoid accidental prefetches counting as a read: rationale — reduces false-positive reads by bots and crawlers.
- No delivery/notification beyond returning the link in Telegram: rationale — keeps scope minimal and preserves sender anonymity.


