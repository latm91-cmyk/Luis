const axios = require('axios');
const { WHATSAPP_TOKEN } = require('../config');

async function downloadWhatsAppMediaAsBuffer(mediaUrl) {
  const r = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  const mimeType =
    (r.headers?.['content-type'] || r.headers?.['Content-Type'] || '')
      .split(';')[0]
      .trim();

  return {
    buf: Buffer.from(r.data),
    mimeType: mimeType || 'image/jpeg',
  };
}

module.exports = { downloadWhatsAppMediaAsBuffer };
