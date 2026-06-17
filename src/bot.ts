import { createBot } from "@agntdev/bot-toolkit";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
// An in-progress /upload. The draft text lives in the session (ephemeral
// conversation state) until later steps validate, encrypt and persist it.
export interface UploadDraft {
  stage: "awaiting_text" | "ready";
  text?: string;
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
    ctx.session.upload = { stage: "ready", text };
    await ctx.reply(
      `✅ Got your message (${text.length} characters). It's ready to be sealed.`,
    );
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
