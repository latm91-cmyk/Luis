const crypto = require('crypto');

function verifyMetaSignature(req, metaSecret) {
  if (!metaSecret) {
    console.error('❌ META_APP_SECRET NO configurado. Bloqueando webhook por seguridad.');
    return false;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody) return false;

  const expected = `sha256=${crypto.createHmac('sha256', metaSecret).update(req.rawBody).digest('hex')}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { verifyMetaSignature };
