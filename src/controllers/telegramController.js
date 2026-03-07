const { TELEGRAM_SECRET_TOKEN, TELEGRAM_BOT_TOKEN } = require('../config');

function extractRef(text = '') {
  const m = String(text).match(/(RP|CASE)-[A-Za-z0-9-]+/i);
  return m ? m[0].toUpperCase() : null;
}

function registerTelegramRoutes(app, deps) {
  const { sheetsRepository, whatsappClient, telegramClient } = deps;

  app.post('/telegram-webhook', async (req, res) => {
    try {
      if (!TELEGRAM_SECRET_TOKEN) {
        console.error('❌ TELEGRAM_SECRET_TOKEN no est configurado (obligatorio).');
        return res.sendStatus(500);
      }

      const incoming = req.headers['x-telegram-bot-api-secret-token'];
      if (incoming !== TELEGRAM_SECRET_TOKEN) return res.sendStatus(401);

      res.sendStatus(200);
      if (!TELEGRAM_BOT_TOKEN || !sheetsRepository.sheets) return;

      const msg = req.body?.message;
      if (!msg) return;

      const chat_id = msg.chat?.id;
      const photos = msg.photo;
      const best = Array.isArray(photos) ? photos[photos.length - 1] : null;
      const file_id = best?.file_id;
      const caption = msg.caption || msg.text || '';
      const ref = extractRef(caption);

      if (!file_id) {
        if (chat_id) await telegramClient.telegramSendMessage(chat_id, '⚠️ Debes enviar una *foto* de la boleta.');
        return;
      }
      if (!ref) {
        if (chat_id) await telegramClient.telegramSendMessage(chat_id, '⚠️ Falta la referencia en el caption. Ej: RP-240224-001');
        return;
      }

      const found = await sheetsRepository.findRowByRef(ref);
      if (!found) {
        if (chat_id) await telegramClient.telegramSendMessage(chat_id, `❌ No encontr® esa referencia en la hoja: ${ref}`);
        return;
      }

      if (found.state !== 'APROBADO' && found.state !== 'BOLETA_ENVIADA') {
        if (chat_id) await telegramClient.telegramSendMessage(chat_id, `⚠️ La referencia ${ref} está en estado: ${found.state}. Primero debe estar APROBADO.`);
        return;
      }

      const file_path = await telegramClient.telegramGetFilePath(file_id);
      const imgBuffer = await telegramClient.telegramDownloadFileBuffer(file_path);
      const mediaId = await whatsappClient.whatsappUploadImageBuffer(imgBuffer, 'image/jpeg');
      await whatsappClient.sendImageByMediaId(found.wa_id, mediaId, `🎟️ Boleta enviada ✅ (${ref})`);

      if (found.state !== 'BOLETA_ENVIADA') {
        await sheetsRepository.updateCell(`D${found.rowNumber}`, 'BOLETA_ENVIADA');
      }

      if (chat_id) {
        await telegramClient.telegramSendMessage(chat_id, `✅ Envie la boleta al cliente (${found.wa_id}) y marque BOLETA_ENVIADA. (${ref})`);
      }
    } catch (err) {
      console.error('❌ /telegram-webhook error:', err);
    }
  });
}

module.exports = { registerTelegramRoutes };
