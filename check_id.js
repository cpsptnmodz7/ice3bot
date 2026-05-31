/**
 * Script sederhana untuk melihat Chat ID group/user Telegram.
 * Jalankan script ini, lalu kirim pesan di group yang sudah ada bot-nya.
 * Chat ID akan muncul di terminal.
 */

const TelegramBot = require("node-telegram-bot-api");

const TELEGRAM_BOT_TOKEN = "8460786092:AAGZt9ZqyC9mQDtJ4YynAG3e2ayvUa4ZC-8";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

console.log("🤖 Bot started! Kirim pesan di group/chat untuk melihat Chat ID...");
console.log("Tekan Ctrl+C untuk berhenti.\n");

bot.on("message", (msg) => {
  console.log("==================================================");
  console.log("CHAT ID    :", msg.chat.id);
  console.log("CHAT TYPE  :", msg.chat.type);
  console.log("CHAT TITLE :", msg.chat.title || "(Private Chat)");
  console.log("USER ID    :", msg.from ? msg.from.id : "N/A");
  console.log("USERNAME   :", msg.from && msg.from.username ? `@${msg.from.username}` : "N/A");
  console.log("FULL NAME  :", msg.from ? `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim() : "N/A");
  console.log("MESSAGE    :", msg.text || "(non-text)");
  console.log("==================================================\n");
});

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});
