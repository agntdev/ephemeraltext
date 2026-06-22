import { buildBot } from "./bot.js";
import { disconnectRedis } from "./redis.js";

// Runtime entry (dist/index.js). BOT_TOKEN is injected at runtime as a secret.
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

const bot = buildBot(token);
bot.start();

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);
  try {
    await bot.stop();
  } catch (err) {
    console.error("Error stopping bot:", err);
  }
  try {
    await disconnectRedis();
  } catch (err) {
    console.error("Error disconnecting Redis:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
