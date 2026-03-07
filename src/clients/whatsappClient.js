const fetch = require('node-fetch');
const FormData = require('form-data');
const { WHATSAPP_TOKEN, PHONE_NUMBER_ID } = require('../config');

function createWhatsAppClient({ saveConversation }) {
  async function sendText(to, bodyText, ref_id = '') {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.warn('⚠️ Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID');
      return { ok: false };
    }

    const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: bodyText },
      }),
    });

    const raw = await resp.text();
    console.log(' WhatsApp send status:', resp.status);
    console.log(' WhatsApp send raw:', raw);

    if (saveConversation) {
      await saveConversation({ wa_id: to, direction: 'OUT', message: bodyText, ref_id });
    }

    return { ok: resp.ok, status: resp.status, raw };
  }

  async function whatsappUploadImageBuffer(buffer, mimeType = 'image/jpeg') {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) throw new Error('Faltan WHATSAPP_TOKEN o PHONE_NUMBER_ID');

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, { filename: 'boleta.jpg', contentType: mimeType });

    const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
      body: form,
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Upload media fallo: ${resp.status} ${JSON.stringify(data)}`);
    return data.id;
  }

  async function sendImageByMediaId(to, mediaId, caption = '') {
    const payload = { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId } };
    if (caption) payload.image.caption = caption;

    const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const raw = await resp.text();
    console.log(' WhatsApp send image status:', resp.status);
    console.log(' WhatsApp send image raw:', raw);

    if (saveConversation) {
      await saveConversation({ wa_id: to, direction: 'OUT', message: `[image sent] ${caption || ''}`.trim(), ref_id: '' });
    }

    return { ok: resp.ok, status: resp.status, raw };
  }

  async function fetchWhatsAppMediaUrl(mediaId) {
    const resp = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    const data = await resp.json().catch(() => ({}));
    if (!data?.url) throw new Error('No media url from Meta: ' + JSON.stringify(data));
    return data.url;
  }

  return { sendText, whatsappUploadImageBuffer, sendImageByMediaId, fetchWhatsAppMediaUrl };
}

module.exports = { createWhatsAppClient };
