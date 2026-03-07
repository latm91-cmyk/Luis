const { GEMINI_API_KEY, GEMINI_MODEL_VISION } = require('../config');

function normalize(parsed) {
  return {
    label: String(parsed.label || 'DUDA').toUpperCase(),
    confidence: Number(parsed.confidence ?? 0),
    why: parsed.why || '',
  };
}

function createMediaClassifier({ geminiGenerateContent, fetchWhatsAppMediaUrl, downloadWhatsAppMediaAsBuffer }) {
  return {
    async classifyPaymentImage({ mediaId }) {
      if (!GEMINI_API_KEY) {
        return { label: 'DUDA', confidence: 0, why: 'GEMINI_API_KEY no configurada' };
      }

      const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
      const { buf, mimeType } = await downloadWhatsAppMediaAsBuffer(mediaUrl);
      const b64Image = buf.toString('base64');

      const prompt = `Clasifica la imagen en UNA sola etiqueta: COMPROBANTE, PUBLICIDAD, OTRO o DUDA.
Reglas:
- COMPROBANTE: recibo de transferencia / depósito, comprobante bancario, Nequi / Daviplata, confirmación de pago, voucher.
- PUBLICIDAD: afiche / promoción, banner con premios, precios, números, logo invitando a comprar.
Devuelve SOLO JSON: {"label":"...","confidence":0-1,"why":"..."}`;

      const out = (
        await geminiGenerateContent({
          model: GEMINI_MODEL_VISION,
          contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { data: b64Image, mimeType } }] }],
        })
      ).trim();

      try {
        const parsed = JSON.parse(out);
        const normalized = normalize(parsed);
        return { ...normalized, mimeType };
      } catch {
        const m = out.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const parsed = JSON.parse(m[0]);
            const normalized = normalize(parsed);
            return { ...normalized, mimeType };
          } catch {}
        }

        return { label: 'DUDA', confidence: 0, why: 'No JSON: ' + out.slice(0, 200) };
      }
    },
  };
}

module.exports = { createMediaClassifier };
