const fetch = require("node-fetch");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

async function telegramSendMessage(chat_id, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
  });
}

async function sendConversationLog(direction, wa_id, message) {
  const groupId = process.env.TELEGRAM_GROUP_ID;
  if (!groupId || !TELEGRAM_BOT_TOKEN) return;

  const prefix = direction === "IN" ? "📩 IN" : "📤 OUT";
  const safeWa = wa_id || "desconocido";
  const text = String(message ?? "").slice(0, 3500);
  const ts = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

  await telegramSendMessage(
    groupId,
    `${prefix} | ${ts}\n👤 ${safeWa}\n📝 ${text}`
  );
}

async function safeConversationLog(direction, wa_id, message) {
  try {
    await sendConversationLog(direction, wa_id, message);
  } catch (e) {
    console.warn("⚠️ sendConversationLog fall:", e?.message || e);
  }
}

function extractRef(text = "") {
  const m = String(text).match(/(RP|CASE)-[A-Za-z0-9-]+/i);
  return m ? m[0].toUpperCase() : null;
}

async function telegramGetFilePath(file_id) {
  const r = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file_id)}`
  );
  const j = await r.json();
  if (!j.ok) throw new Error("getFile fallo: " + JSON.stringify(j));
  return j.result.file_path;
}

module.exports = {
  telegramSendMessage,
  safeConversationLog,
  extractRef,
  telegramGetFilePath
};