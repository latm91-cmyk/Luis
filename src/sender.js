const fetch = require("node-fetch");
const FormData = require("form-data");
const axios = require("axios");
const { saveConversation } = require("../sheets/sheetsService");
const { memPush } = require("../boletas/boletasMemory");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";

async function sendText(sheets, sheetId, to, bodyText, ref_id = "") {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ Error CRÍTICO: Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID.");
    return { ok: false };
  }

  const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: bodyText },
    }),
  });

  const raw = await resp.text();
  
  if (!resp.ok) {
    console.error(`❌ Error enviando mensaje a WhatsApp (${resp.status}):`, raw);
  } else {
    console.log("✅ Mensaje enviado correctamente a WhatsApp.");
  }

  await saveConversation(sheets, sheetId, { wa_id: to, direction: "OUT", message: bodyText, ref_id });

  return { ok: resp.ok, status: resp.status, raw };
}

async function sendTextM(sheets, sheetId, to, bodyText, ref_id = "") {
  const r = await sendText(sheets, sheetId, to, bodyText, ref_id);
  if (r.ok) {
    memPush(to, "assistant", bodyText);
  }
  return r;
}

async function whatsappUploadImageBuffer(buffer, mimeType = "image/jpeg") {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) throw new Error("Faltan WHATSAPP_TOKEN o PHONE_NUMBER_ID");

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename: "boleta.jpg", contentType: mimeType });

  const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Upload media fallo: ${resp.status} ${JSON.stringify(data)}`);
  return data.id;
}

async function sendImageByMediaId(sheets, sheetId, to, mediaId, caption = "") {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { id: mediaId },
  };
  if (caption) payload.image.caption = caption;

  const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  await saveConversation(sheets, sheetId, { wa_id: to, direction: "OUT", message: `[image sent] ${caption || ""}`.trim(), ref_id: "" });

  return { ok: resp.ok, status: resp.status };
}

async function fetchWhatsAppMediaUrl(mediaId) {
  const resp = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const data = await resp.json().catch(() => ({}));
  if (!data?.url) throw new Error("No media url from Meta: " + JSON.stringify(data));
  return data.url;
}

async function downloadWhatsAppMediaAsBuffer(mediaUrl) {
  const r = await axios.get(mediaUrl, { responseType: "arraybuffer", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const mimeType = (r.headers?.["content-type"] || "").split(";")[0].trim();
  return { buf: Buffer.from(r.data), mimeType: mimeType || "image/jpeg" };
}

module.exports = {
  sendText,
  sendTextM,
  whatsappUploadImageBuffer,
  sendImageByMediaId,
  fetchWhatsAppMediaUrl,
  downloadWhatsAppMediaAsBuffer
};