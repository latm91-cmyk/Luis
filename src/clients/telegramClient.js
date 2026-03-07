const fetch = require('node-fetch');
const FormData = require('form-data');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_ID } = require('../config');

async function telegramSendMessage(chat_id, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text }),
  });
}

async function telegramSendPhotoBuffer(chat_id, buffer, caption = '') {
  if (!TELEGRAM_BOT_TOKEN || !chat_id) return;

  const form = new FormData();
  form.append('chat_id', String(chat_id));
  if (caption) form.append('caption', caption);
  form.append('photo', buffer, { filename: 'comprobante.jpg' });

  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  });

  const data = await r.json().catch(() => ({}));
  if (!data?.ok) throw new Error('Telegram sendPhoto failed: ' + JSON.stringify(data));
}

async function sendConversationLog(direction, wa_id, message) {
  if (!TELEGRAM_GROUP_ID || !TELEGRAM_BOT_TOKEN) return;

  const prefix = direction === 'IN' ? '📩 IN' : '📤 OUT';
  const safeWa = wa_id || 'desconocido';
  const text = String(message ?? '').slice(0, 3500);
  const ts = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

  await telegramSendMessage(TELEGRAM_GROUP_ID, `${prefix} | ${ts}\n👤 ${safeWa}\n📝 ${text}`);
}

async function safeConversationLog(direction, wa_id, message) {
  try {
    await sendConversationLog(direction, wa_id, message);
  } catch (e) {
    console.warn('⚠️ sendConversationLog fall:', e?.message || e);
  }
}

async function telegramGetFilePath(file_id) {
  const r = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file_id)}`,
  );
  const j = await r.json();
  if (!j.ok) throw new Error('getFile fallo: ' + JSON.stringify(j));
  return j.result.file_path;
}

async function telegramDownloadFileBuffer(file_path) {
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('download file fallo: ' + r.status);
  return await r.buffer();
}

module.exports = {
  telegramSendMessage,
  telegramSendPhotoBuffer,
  sendConversationLog,
  safeConversationLog,
  telegramGetFilePath,
  telegramDownloadFileBuffer,
};
