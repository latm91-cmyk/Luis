const fetch = require("node-fetch");
const { memGet, memPush } = require("../boletas/boletasMemory");
const { SYSTEM_PROMPT } = require("./prompt");
const { downloadWhatsAppMediaAsBuffer, fetchWhatsAppMediaUrl } = require("../whatsapp/sender");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

async function geminiGenerateContent({ model, systemInstruction = "", contents = [] }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY no configurada");
  }

  const selectedModel = String(model || "").trim() || "gemini-2.5-flash";

  const endpoint =
    `https://generativelanguage.googleapis.com/v1/models/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    contents: [
      ...(systemInstruction
        ? [{ role: "user", parts: [{ text: systemInstruction }] }]
        : []),
      ...contents
    ]
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Gemini API error: ${resp.status} ${JSON.stringify(data)}`);
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "")
      .join("\n")
      .trim() || "";

  return text;
}

async function askGemini(wa_id, userText, state = "BOT") {
  if (!GEMINI_API_KEY) {
    return "Te gustaría participar o conocer precios de boletas?";
  }

  const history = memGet(wa_id);

  const contents = history
    .map(msg => {
      const role =
        msg.role === "assistant" || msg.role === "model"
          ? "model"
          : "user";

      const text = String(msg.content || "").trim();
      if (!text) return null;

      return { role, parts: [{ text }] };
    })
    .filter(Boolean);

  const outputRaw = await geminiGenerateContent({
    model: process.env.GEMINI_MODEL_TEXT || "gemini-2.5-flash",
    systemInstruction: `${SYSTEM_PROMPT}\n\nEstado actual del cliente: ${state}`,
    contents
  }).catch(error => {
    console.error("❌ Error Gemini texto:", error?.message || error);
    return "Lo siento, estoy teniendo problemas de conexión. ¿Podrías repetirme eso?";
  });

  const output = String(outputRaw || "").trim() || "Me repites, por favor?";

  memPush(wa_id, "assistant", output);

  return output;
}

async function classifyPaymentImage({ mediaId }) {
  if (!GEMINI_API_KEY) {
    return { label: "DUDA", confidence: 0, why: "GEMINI_API_KEY no configurada" };
  }

  const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
  const { buf, mimeType } = await downloadWhatsAppMediaAsBuffer(mediaUrl);

  const b64Image = buf.toString("base64");

  const prompt = `Clasifica la imagen en UNA sola etiqueta: COMPROBANTE, PUBLICIDAD, OTRO o DUDA.
Reglas:
- COMPROBANTE: recibo de transferencia / depósito, comprobante bancario, Nequi / Daviplata, confirmación de pago, voucher.
- PUBLICIDAD: afiche / promoción, banner con premios, precios, números, logo invitando a comprar.
Devuelve SOLO JSON: {"label":"...","confidence":0-1,"why":"..."}`;

  const out = await geminiGenerateContent({
    model: process.env.GEMINI_MODEL_VISION || "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { data: b64Image, mimeType } }
        ]
      }
    ]
  });

  return out.trim();
}

module.exports = {
  askGemini,
  classifyPaymentImage,
  geminiGenerateContent
};