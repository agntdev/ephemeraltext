import { createBot } from "@agntdev/bot-toolkit";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  // example: step?: "awaiting_amount";
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

  return bot;
}
