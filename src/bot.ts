import { createBot, type BotContext } from "./toolkit/index.js";
import { isAbusive } from "./content.js";
import { RateLimiter, createRateLimitBackend } from "./ratelimit.js";
import {
  createMessageStore,
  generatePublicToken,
  isValidPublicToken,
  newMessage,
} from "./messages.js";
import { encrypt, generateDataKey, wipe } from "./crypto.js";
import { createKms } from "./kms.js";
import { readMessage } from "./retrieval.js";
import { isAdmin } from "./admin.js";
import { createAuditLog, type AuditEntry } from "./audit.js";
import { hashSenderId } from "./identity.js";
import type { ExpiryMode } from "./types.js";

export type { ExpiryMode };

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).

// An in-progress /upload. The draft text lives in the session (ephemeral
// conversation state) until later steps validate, encrypt and persist it.
export interface UploadDraft {
  stage: "awaiting_text" | "awaiting_mode" | "awaiting_duration" | "ready";
  text?: string;
  mode?: ExpiryMode;
}

export interface Session {
  upload?: UploadDraft;
}

// The /start welcome line. Kept stable so the scaffold dialog spec keeps passing.
const WELCOME =
  "🔥 Welcome to EphemeralText — send encrypted, self-destructing messages. Use /help to get started.";

// Main menu — an inline keyboard routing to the bot's top-level features.
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "📝 New Message", callback_data: "menu:new" }],
    [{ text: "ℹ️ About", callback_data: "menu:about" }],
  ],
};

// Copy shown when a menu button routes the user to a top-level feature.
const NEW_MESSAGE_TEXT =
  "📝 New ephemeral message\n\nSend /upload to create an encrypted message that self-destructs after it is read.";
const ABOUT_TEXT =
  "ℹ️ About EphemeralText\n\nMessages are encrypted and shared via a one-time link. Each message self-destructs on first read or when its timer expires — nothing is kept afterwards.";

// A single "⬅️ Back" row returning to the main menu, reused by sub-screens.
const BACK_MENU = {
  inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu:home" }]],
};

// /help body — lists the commands the bot understands.
const HELP_TEXT =
  "❓ EphemeralText — Help\n\nAvailable commands:\n/start — open the main menu\n/help — show this help\n\nUse /start to create and share encrypted, self-destructing messages.";

// /upload — prompt shown when the user starts a new ephemeral message.
const UPLOAD_PROMPT =
  "📝 Send me the text you want to share as an ephemeral message.";

// The maximum length of an ephemeral message, in characters.
const MAX_MESSAGE_LENGTH = 10000;

// Shown when the user's draft exceeds the size limit (they stay in the prompt).
function tooLongText(length: number): string {
  return `⚠️ That message is too long (${length} characters). The maximum is 10,000 characters. Please send a shorter message and try again.`;
}

// Asks the user how the message should expire, once a valid draft is captured.
const MODE_PROMPT = "✅ Got your message. How should it expire?";
const MODE_MENU = {
  inline_keyboard: [
    [{ text: "👁 First read", callback_data: "upload:mode:first-read" }],
    [{ text: "⏱ Time-limited", callback_data: "upload:mode:time-limited" }],
  ],
};

// Short description of each expiry mode, used in the shareable-link message.
const MODE_DESCRIPTION: Record<ExpiryMode, string> = {
  "first-read": "👁 It will self-destruct after it is read once.",
  "time-limited": "⏱ It will expire after the selected time limit.",
};

// Selectable time-limited durations (label + milliseconds). Capped at 7 days.
const DURATIONS: { key: string; label: string; ms: number }[] = [
  { key: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { key: "1d", label: "1 day", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
];
const DURATION_BY_KEY = new Map(DURATIONS.map((d) => [d.key, d]));

// Backstop retention for first-read messages that are never opened, after which
// they are auto-deleted from storage.
const FIRST_READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DURATION_PROMPT = "⏱ How long should this message stay available?";
const DURATION_MENU = {
  inline_keyboard: DURATIONS.map((d) => [
    { text: d.label, callback_data: `upload:ttl:${d.key}` },
  ]),
};

// Base URL the public share links are built from. Production sets PUBLIC_BASE_URL;
// the placeholder matches the spec's example domain for dev/tests.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://example.com";

// Build the public, shareable link for a stored message token.
function shareLink(token: string): string {
  return `${PUBLIC_BASE_URL.replace(/\/$/, "")}/r/${token}`;
}

// The message shown once a draft is sealed and its share link is generated.
function sealedText(mode: ExpiryMode, link: string): string {
  return `✅ Your ephemeral message is ready!\n\nShare this link:\n${link}\n\n${MODE_DESCRIPTION[mode]}`;
}

// Shown if a mode button is tapped but the upload draft is no longer pending.
const UPLOAD_EXPIRED_TEXT =
  "This upload is no longer active. Send /upload to start again.";

// Rate limit: at most this many uploads per user within the rolling window.
const MAX_UPLOADS_PER_HOUR = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMITED_TEXT =
  "⏳ You've reached the limit of 10 uploads per hour. Please try again later.";

// Rate limit for admin commands (metrics/logs/delete) — prevents abuse of
// expensive operations like Redis SCAN and audit-log flooding.
const MAX_ADMIN_CMDS_PER_HOUR = 10;
const ADMIN_RATE_LIMITED_TEXT =
  "⏳ You've reached the limit of 10 admin commands per hour. Please try again later.";

// Shown when the draft trips the spam / content-policy heuristics.
const ABUSIVE_TEXT =
  "🚫 That message looks like spam and can't be shared. Please revise it and try again.";

// /read — copy for viewing a shared message by its public token.
const READ_USAGE_TEXT =
  "Usage: /read <token>\n\nThe token is the last part of a share link (…/r/<token>).";
const READ_INVALID_TEXT =
  "⚠️ That link doesn't look valid. Please check that you copied the full share link.";
const READ_NOT_FOUND_TEXT =
  "❓ That message doesn't exist or has already been viewed.";
const READ_EXPIRED_TEXT = "⌛ That message has expired and is no longer available.";
const ONE_TIME_VIEW_NOTICE =
  "\n\n🔥 This was a one-time message — it has now been permanently deleted.";

// /admin — moderation surface, restricted to configured admins.
const ADMIN_DENIED_TEXT = "⛔ You are not authorized to use this command.";
const ADMIN_MENU_TEXT =
  "🛠 Admin panel\n\nCommands:\n/admin metrics — usage metrics\n/admin logs — recent admin actions\n/admin delete <token> — delete a message";
const ADMIN_MENU = {
  inline_keyboard: [
    [{ text: "📊 Metrics", callback_data: "admin:metrics" }],
    [{ text: "📜 Logs", callback_data: "admin:logs" }],
  ],
};
const ADMIN_DELETE_USAGE = "Usage: /admin delete <token>";
const ADMIN_NO_LOGS_TEXT = "📜 No admin actions logged yet.";

function formatAuditLog(entries: AuditEntry[]): string {
  const lines = entries.map((e) => {
    const when = new Date(e.at).toISOString();
    const target = e.target ? ` ${e.target}` : "";
    return `• ${when} — ${e.action}${target} by ${e.operator.slice(0, 8)}…`;
  });
  return `📜 Recent admin actions:\n${lines.join("\n")}`;
}

// Shown when the user sends a command the bot does not recognize.
const UNKNOWN_COMMAND_TEXT =
  "🤔 I don't recognize that command. Use /help to see what I can do.";

// Shown by the global error boundary when a handler throws unexpectedly.
const ERROR_TEXT = "⚠️ Something went wrong. Please try again.";

/**
 * buildBot — assembles the bot and registers every handler, but does NOT start
 * it. Shared by the runtime entry (src/index.ts) and the Tests-gate harness
 * (src/harness-entry.ts) so both exercise the exact same bot. Add new commands
 * and flows here.
 */
export function buildBot(token: string) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });

  // Per-bot rate limiter. Backed by Redis in production (REDIS_URL) and an
  // in-process counter in dev/tests. Created here (not module-level) so each
  // harness bot instance starts with a clean window.
  const rateLimiter = new RateLimiter(createRateLimitBackend(), {
    max: MAX_UPLOADS_PER_HOUR,
    windowMs: RATE_LIMIT_WINDOW_MS,
    namespace: "upload",
  });

  // Admin-rate limiter (separate namespace so admin quotas don't consume upload
  // quota and vice versa).
  const adminRateLimiter = new RateLimiter(createRateLimitBackend(), {
    max: MAX_ADMIN_CMDS_PER_HOUR,
    windowMs: RATE_LIMIT_WINDOW_MS,
    namespace: "admin",
  });

  // Durable store for shared messages (Redis in prod, in-process in dev/tests).
  const messageStore = createMessageStore();

  // Key management for envelope encryption (AWS KMS in prod, local key otherwise).
  const kms = createKms();

  // Append-only audit log of admin actions (Redis in prod, in-process otherwise).
  const auditLog = createAuditLog();

  // Record an admin action to the audit log. Operator ids are hashed (HMAC) and
  // entries never contain message plaintext — only the action, hashed operator,
  // optional target token, and a timestamp.
  async function logAdmin(
    ctx: BotContext<Session>,
    action: string,
    target?: string,
  ): Promise<void> {
    await auditLog.record({
      action,
      operator: hashSenderId(ctx.from!.id),
      target,
      at: Date.now(),
    });
  }

  // Admin views, shared by the /admin subcommands and the inline-menu buttons.
  // Each view is itself an admin action and is recorded to the audit log.
  async function showMetrics(ctx: BotContext<Session>): Promise<void> {
    await logAdmin(ctx, "metrics");
    const stored = await messageStore.count();
    await ctx.reply(`📊 Messages currently stored: ${stored}`);
  }
  async function showLogs(ctx: BotContext<Session>): Promise<void> {
    await logAdmin(ctx, "logs");
    const entries = await auditLog.recent(10);
    await ctx.reply(entries.length ? formatAuditLog(entries) : ADMIN_NO_LOGS_TEXT);
  }

  // Seal a captured draft: encrypt under a fresh data key, persist a Message, and
  // edit the prompt into the shareable-link message. Shared by both expiry modes.
  async function sealDraft(
    ctx: BotContext<Session>,
    text: string,
    mode: ExpiryMode,
    expiresAt: number | null,
  ): Promise<void> {
    const now = Date.now();
    const token = generatePublicToken();
    const dataKey = generateDataKey();
    const message = newMessage({
      publicToken: token,
      encryptedPayload: encrypt(text, dataKey),
      wrappedDataKey: await kms.wrap(dataKey),
      mode,
      createdAt: now,
      expiresAt,
    });
    wipe(dataKey);
    // Schedule automatic deletion: at the expiry for time-limited messages, or a
    // retention cap for first-read messages that are never opened.
    const ttlMs =
      expiresAt !== null
        ? Math.max(1000, expiresAt - now)
        : FIRST_READ_RETENTION_MS;
    await messageStore.save(message, Math.ceil(ttlMs / 1000));
    ctx.session.upload = undefined;
    await ctx.editMessageText(sealedText(mode, shareLink(token)));
  }

  // /start — greet the user and show the main menu.
  bot.command("start", async (ctx) => {
    await ctx.reply(WELCOME, { reply_markup: MAIN_MENU });
  });

  // /help — list the commands the bot understands.
  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  // /upload — start a new ephemeral message by asking for its text. The next
  // plain-text message the user sends is captured as the draft (see below).
  bot.command("upload", async (ctx) => {
    ctx.session.upload = { stage: "awaiting_text" };
    await ctx.reply(UPLOAD_PROMPT);
  });

  // /read <token> — view a shared message, enforcing its expiry policy. Backs
  // the same retrieval service a web frontend would call.
  bot.command("read", async (ctx) => {
    const token = ctx.match.trim();
    if (!token) {
      await ctx.reply(READ_USAGE_TEXT);
      return;
    }
    // Reject malformed links before touching storage — a friendly "invalid" page.
    if (!isValidPublicToken(token)) {
      await ctx.reply(READ_INVALID_TEXT);
      return;
    }
    const result = await readMessage(messageStore, kms, token);
    if (result.status === "not_found") {
      await ctx.reply(READ_NOT_FOUND_TEXT);
      return;
    }
    if (result.status === "expired") {
      await ctx.reply(READ_EXPIRED_TEXT);
      return;
    }
    const notice = result.oneTimeView ? ONE_TIME_VIEW_NOTICE : "";
    await ctx.reply(`📨 ${result.text}${notice}`);
  });

  // /admin [metrics|logs|delete <token>] — moderation surface for admins only.
  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply(ADMIN_DENIED_TEXT);
      return;
    }
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    const sub = args[0]?.toLowerCase();
    if (sub === "metrics" || sub === "logs" || sub === "delete") {
      const allowed = await adminRateLimiter.allow(ctx.from!.id);
      if (!allowed) {
        await ctx.reply(ADMIN_RATE_LIMITED_TEXT);
        return;
      }
    }
    if (sub === "metrics") {
      await showMetrics(ctx);
    } else if (sub === "logs") {
      await showLogs(ctx);
    } else if (sub === "delete") {
      const token = args[1];
      if (!token || !isValidPublicToken(token)) {
        await ctx.reply(ADMIN_DELETE_USAGE);
        return;
      }
      const existing = await messageStore.load(token);
      await logAdmin(ctx, "delete", token);
      await messageStore.delete(token);
      await ctx.reply(
        existing ? `🗑 Message ${token} deleted.` : `Message ${token} was not found.`,
      );
    } else {
      await ctx.reply(ADMIN_MENU_TEXT, { reply_markup: ADMIN_MENU });
    }
  });

  // Main-menu navigation. Each branch routes to a top-level feature and offers
  // a way back, so every button is reachable and does real work.
  bot.on("callback_query:data", async (ctx) => {
    try {
      const data = ctx.callbackQuery.data;

      if (data === "menu:home") {
        await ctx.editMessageText(WELCOME, { reply_markup: MAIN_MENU });
      } else if (data === "menu:new") {
        await ctx.editMessageText(NEW_MESSAGE_TEXT, { reply_markup: BACK_MENU });
      } else if (data === "menu:about") {
        await ctx.editMessageText(ABOUT_TEXT, { reply_markup: BACK_MENU });
      } else if (data === "upload:mode:first-read") {
        // First-read messages seal immediately — no expiry timestamp.
        const draft = ctx.session.upload;
        if (draft?.stage === "awaiting_mode" && draft.text) {
          await sealDraft(ctx, draft.text, "first-read", null);
        } else {
          await ctx.editMessageText(UPLOAD_EXPIRED_TEXT);
        }
      } else if (data === "upload:mode:time-limited") {
        // Time-limited messages need a duration before they can be sealed.
        const draft = ctx.session.upload;
        if (draft?.stage === "awaiting_mode" && draft.text) {
          ctx.session.upload = {
            stage: "awaiting_duration",
            text: draft.text,
            mode: "time-limited",
          };
          await ctx.editMessageText(DURATION_PROMPT, { reply_markup: DURATION_MENU });
        } else {
          await ctx.editMessageText(UPLOAD_EXPIRED_TEXT);
        }
      } else if (data.startsWith("upload:ttl:")) {
        // A duration was chosen — seal with an absolute expiry (<= 7 days out).
        const duration = DURATION_BY_KEY.get(data.slice("upload:ttl:".length));
        const draft = ctx.session.upload;
        if (duration && draft?.stage === "awaiting_duration" && draft.text) {
          await sealDraft(ctx, draft.text, "time-limited", Date.now() + duration.ms);
        } else {
          await ctx.editMessageText(UPLOAD_EXPIRED_TEXT);
        }
      } else if (data === "admin:metrics" || data === "admin:logs") {
        if (!isAdmin(ctx.from?.id)) {
          await ctx.reply(ADMIN_DENIED_TEXT);
        } else {
          const allowed = await adminRateLimiter.allow(ctx.from.id);
          if (!allowed) {
            await ctx.reply(ADMIN_RATE_LIMITED_TEXT);
          } else if (data === "admin:metrics") {
            await showMetrics(ctx);
          } else {
            await showLogs(ctx);
          }
        }
      }
    } finally {
      // Always stop the client-side loading spinner.
      await ctx.answerCallbackQuery();
    }
  });

  // Unknown-command fallback. Registered AFTER every command handler, so it only
  // fires for command-looking messages that no command() above matched. Filtering
  // on the bot_command entity means plain free-text input is never swallowed.
  bot.on("message:entities:bot_command", async (ctx) => {
    await ctx.reply(UNKNOWN_COMMAND_TEXT);
  });

  // Capture the draft text for an in-progress /upload. Registered after the
  // command handlers, so a command message never reaches here — only the plain
  // text the user sends in response to the upload prompt.
  bot.on("message:text", async (ctx, next) => {
    const draft = ctx.session.upload;
    if (draft?.stage !== "awaiting_text") {
      await next();
      return;
    }
    const text = ctx.message.text;
    if (text.length > MAX_MESSAGE_LENGTH) {
      // Reject oversize input and keep waiting for a valid draft.
      await ctx.reply(tooLongText(text.length));
      return;
    }
    if (isAbusive(text)) {
      // Reject spam outright and cancel the draft.
      ctx.session.upload = undefined;
      await ctx.reply(ABUSIVE_TEXT);
      return;
    }
    // Count this upload against the per-user hourly limit. Checked after the
    // cheap content checks so rejected garbage doesn't consume the quota.
    const allowed = await rateLimiter.allow(ctx.from?.id ?? 0);
    if (!allowed) {
      ctx.session.upload = undefined;
      await ctx.reply(RATE_LIMITED_TEXT);
      return;
    }
    ctx.session.upload = { stage: "awaiting_mode", text };
    await ctx.reply(MODE_PROMPT, { reply_markup: MODE_MENU });
  });

  // Global error boundary — an unhandled error in any handler replies gracefully
  // instead of crashing the bot. The secondary reply is itself guarded so a
  // failure while reporting the error can't throw again.
  bot.catch(async (err) => {
    console.error("Unhandled bot error:", err.error);
    try {
      await err.ctx.reply(ERROR_TEXT);
    } catch (replyErr) {
      console.error("Failed to send error reply:", replyErr);
    }
  });

  return bot;
}
