import { createBot } from "@agntdev/bot-toolkit";
import { isAbusive } from "./content.js";
import { RateLimiter, createRateLimitBackend } from "./ratelimit.js";
import { createMessageStore, generatePublicToken } from "./messages.js";
import { encrypt, generateDataKey } from "./crypto.js";
import type { ExpiryMode } from "./types.js";

export type { ExpiryMode };

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).

// An in-progress /upload. The draft text lives in the session (ephemeral
// conversation state) until later steps validate, encrypt and persist it.
export interface UploadDraft {
  stage: "awaiting_text" | "awaiting_mode" | "ready";
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
  "time-limited": "⏱ It will expire after a time limit.",
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

// Shown when the draft trips the spam / content-policy heuristics.
const ABUSIVE_TEXT =
  "🚫 That message looks like spam and can't be shared. Please revise it and try again.";

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
  });

  // Durable store for shared messages (Redis in prod, in-process in dev/tests).
  const messageStore = createMessageStore();

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

  // Main-menu navigation. Each branch routes to a top-level feature and offers
  // a way back, so every button is reachable and does real work.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data === "menu:home") {
      await ctx.editMessageText(WELCOME, { reply_markup: MAIN_MENU });
    } else if (data === "menu:new") {
      await ctx.editMessageText(NEW_MESSAGE_TEXT, { reply_markup: BACK_MENU });
    } else if (data === "menu:about") {
      await ctx.editMessageText(ABOUT_TEXT, { reply_markup: BACK_MENU });
    } else if (data === "upload:mode:first-read" || data === "upload:mode:time-limited") {
      const mode: ExpiryMode =
        data === "upload:mode:first-read" ? "first-read" : "time-limited";
      const draft = ctx.session.upload;
      if (draft?.stage === "awaiting_mode" && draft.text) {
        // Seal the draft: encrypt the text under a fresh per-message data key,
        // store it under a public token, and hand back the shareable link. The
        // draft is then cleared from the session.
        const token = generatePublicToken();
        const dataKey = generateDataKey();
        await messageStore.save(token, {
          payload: encrypt(draft.text, dataKey),
          dataKey: dataKey.toString("base64"),
          mode,
          createdAt: Date.now(),
        });
        ctx.session.upload = undefined;
        await ctx.editMessageText(sealedText(mode, shareLink(token)));
      } else {
        await ctx.editMessageText(UPLOAD_EXPIRED_TEXT);
      }
    }

    // Always stop the client-side loading spinner.
    await ctx.answerCallbackQuery();
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
