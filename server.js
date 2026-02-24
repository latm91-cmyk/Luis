const express = require("express");
const { google } = require("googleapis");
const fetch = require("node-fetch"); // v2
const crypto = require("crypto");
const FormData = require("form-data");
const OpenAI = require("openai");

const app = express();

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

/* ================= CONFIG ================= */

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "rifas_verify_123";

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB_NAME = process.env.GOOGLE_SHEET_TAB || "cases";

const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN || ""; // OBLIGATORIO

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Control follow-up de ventas (1 solo recordatorio)
const followUps = new Map();

/* ================= GOOGLE SHEETS CLIENT ================= */

let sheets = null;
if (SHEET_ID && GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY) {
  const auth = new google.auth.JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });
} else {
  console.warn("⚠️ Sheets NO configurado (revisa GOOGLE_SHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY).");
}

/* ================= HELPERS ================= */

function todayYYMMDD() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function isBuyIntent(text = "") {
  const t = String(text).toLowerCase();
  return (
    t.includes("comprar") ||
    t.includes("precio") ||
    t.includes("boleta") ||
    t.includes("boletas") ||
    t.includes("participar") ||
    t.includes("quiero")
  );
}

function isThanks(text = "") {
  const t = String(text).toLowerCase().trim();
  return /\b(gracias|muchas gracias|mil gracias|grac)\b/.test(t);
}

/* ================= META SIGNATURE VALIDATION ================= */

function verifyMetaSignature(req) {
  const appSecret = process.env.META_APP_SECRET;
  const signature = req.headers["x-hub-signature-256"];

  if (!appSecret) {
    console.warn("⚠️ META_APP_SECRET no configurado. (Validación Meta desactivada)");
    return true;
  }
  if (!signature || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/* ================= SHEETS OPS ================= */

async function getAllRowsAtoH() {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:H`,
  });
  return res.data.values || [];
}

async function getLatestStateByWaId(wa_id) {
  const rows = await getAllRowsAtoH();
  let lastState = "BOT";
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row?.[2] === wa_id && row?.[3]) lastState = row[3];
  }
  return lastState;
}

async function getLastRefNumberForToday() {
  const rows = await getAllRowsAtoH();
  const prefix = `RP-${todayYYMMDD()}-`;
  let max = 0;
  for (let i = 1; i < rows.length; i++) {
    const id = rows[i]?.[1] || ""; // Col B ref
    if (id.startsWith(prefix)) {
      const n = parseInt(id.replace(prefix, ""), 10);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    }
  }
  return max;
}

async function createReference({ wa_id, last_msg_type, receipt_media_id, receipt_is_payment }) {
  if (!sheets) {
    const ref = `RP-${todayYYMMDD()}-000`;
    return { ref, state: "EN_REVISION" };
  }

  const max = await getLastRefNumberForToday();
  const next = String(max + 1).padStart(3, "0");
  const ref = `RP-${todayYYMMDD()}-${next}`;

  const created_at = new Date().toISOString();
  const state = "EN_REVISION";

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        created_at,                 // A created_at
        ref,                        // B ref_id (antes CASE)
        wa_id,                      // C wa_id
        state,                      // D state
        last_msg_type,              // E last_msg_type
        receipt_media_id || "",     // F receipt_media_id
        receipt_is_payment || "UNKNOWN", // G receipt_is_payment
        "",                         // H notes
      ]],
    },
  });

  return { ref, state };
}

async function findRowByRef(refOrCase) {
  const rows = await getAllRowsAtoH();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if ((row?.[1] || "") === refOrCase) {
      return {
        rowNumber: i + 1,
        ref: row?.[1] || "",
        wa_id: row?.[2] || "",
        state: row?.[3] || "",
        notes: row?.[7] || "",
      };
    }
  }
  return null;
}

async function updateCell(rangeA1, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!${rangeA1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
}

/* ================= WHATSAPP SEND ================= */

async function sendText(to, bodyText) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.warn("⚠️ Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID");
    return { ok: false };
  }

  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: bodyText },
    }),
  });

  return { ok: resp.ok, status: resp.status, raw: await resp.text() };
}

async function whatsappUploadImageBuffer(buffer, mimeType = "image/jpeg") {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error("Faltan WHATSAPP_TOKEN o PHONE_NUMBER_ID");

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename: "boleta.jpg", contentType: mimeType });

  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Upload media fallo: ${resp.status} ${JSON.stringify(data)}`);
  return data.id;
}

async function sendImageByMediaId(to, mediaId, caption = "") {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { id: mediaId },
  };
  if (caption) payload.image.caption = caption;

  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return { ok: resp.ok, status: resp.status, raw: await resp.text() };
}

/* ================= OPENAI VISION: PUBLICIDAD vs COMPROBANTE ================= */

async function fetchWhatsAppMediaUrl(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  const resp = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!data?.url) throw new Error("No media url from Meta: " + JSON.stringify(data));
  return data.url;
}

async function downloadWhatsAppMediaAsBuffer(mediaUrl) {
  const token = process.env.WHATSAPP_TOKEN;
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

function bufferToDataUrl(buffer, mimeType = "image/jpeg") {
  const b64 = buffer.toString("base64");
  return `data:${mimeType};base64,${b64}`;
}

async function classifyPaymentImage({ mediaId }) {
  // Si no hay OpenAI, no bloqueamos: dejamos pasar como DUDA
  if (!openai) return { label: "DUDA", confidence: 0, why: "OPENAI_API_KEY no configurada" };

  const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
  const buf = await downloadWhatsAppMediaAsBuffer(mediaUrl);
  const dataUrl = bufferToDataUrl(buf, "image/jpeg");

  const prompt = `Clasifica la imagen en UNA sola etiqueta: COMPROBANTE, PUBLICIDAD, OTRO o DUDA.
Reglas:
- COMPROBANTE: recibo de transferencia/depósito, comprobante bancario, Nequi/Daviplata, confirmación de pago, voucher.
- PUBLICIDAD: afiche/promoción, banner con premios, precios, números, logo invitando a comprar.
Devuelve SOLO JSON: {"label":"...","confidence":0-1,"why":"..."}`;

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
  });

  const out = (resp.output_text || "").trim();
  try {
    const parsed = JSON.parse(out);
    return {
      label: (parsed.label || "DUDA").toUpperCase(),
      confidence: Number(parsed.confidence ?? 0),
      why: parsed.why || "",
    };
  } catch {
    return { label: "DUDA", confidence: 0, why: "No JSON: " + out.slice(0, 120) };
  }
}

/* ================= MONITOR APROBADOS ================= */

async function monitorAprobados() {
  try {
    if (!sheets) return;
    const rows = await getAllRowsAtoH();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const wa_id = row?.[2];
      const state = row?.[3];
      const notes = row?.[7];

      if (state === "APROBADO" && notes !== "NOTIFIED_APROBADO") {
        await sendText(wa_id, "✅ Tu pago fue aprobado. En breve te enviamos tu boleta. 🙌");
        // notes = col H
        await updateCell(`H${i + 1}`, "NOTIFIED_APROBADO");
      }
    }
  } catch (err) {
    console.error("❌ monitorAprobados:", err);
  }
}

/* ================= TELEGRAM HELPERS ================= */

function extractRef(text = "") {
  // Compatibilidad: acepta RP- o CASE- (por si quedan referencias antiguas)
  const m = String(text).match(/(RP|CASE)-[A-Za-z0-9-]+/i);
  return m ? m[0].toUpperCase() : null;
}

async function telegramSendMessage(chat_id, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
  });
}

async function telegramGetFilePath(file_id) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file_id)}`);
  const j = await r.json();
  if (!j.ok) throw new Error("getFile fallo: " + JSON.stringify(j));
  return j.result.file_path;
}

async function telegramDownloadFileBuffer(file_path) {
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("download file fallo: " + r.status);
  const buf = await r.buffer();
  return buf;
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => res.send("OK ✅"));

// Meta verify
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Meta receive
app.post("/webhook", async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const wa_id = msg.from;
    const type = msg.type;

    // Si el cliente responde, cancelar recordatorio pendiente
    if (followUps.has(wa_id)) {
      clearTimeout(followUps.get(wa_id));
      followUps.delete(wa_id);
    }

    // TEXT
    if (type === "text") {
      const text = (msg.text?.body || "").trim();
      const state = await getLatestStateByWaId(wa_id);

      // Gracias: responder humano según estado
      if (isThanks(text)) {
        if (state === "BOLETA_ENVIADA") {
          await sendText(wa_id, "🙏 ¡Gracias a ti por tu compra! Mucha suerte 🍀 Si necesitas algo más, aquí estoy.");
          return;
        }
        if (state === "APROBADO") {
          await sendText(wa_id, "🙏 ¡Con gusto! Tu pago ya está aprobado. En breve te enviamos tu boleta. 🙌");
          return;
        }
        if (state === "EN_REVISION") {
          await sendText(wa_id, "🙏 ¡Con gusto! Tu pago sigue en revisión. Apenas quede aprobado te aviso.");
          return;
        }
        await sendText(wa_id, "🙏 ¡Con gusto! ¿Deseas participar en la rifa?");
        return;
      }

      // Ventas: intención primero
      if (isBuyIntent(text)) {
        await sendText(
          wa_id,
          "🔥 Excelente decisión 🙌\n\n" +
          "🎟 1 boleta: $15.000\n" +
          "🎟🎟 2 boletas: $25.000\n" +
          "🎟🎟🎟🎟🎟 5 boletas: $60.000 (MEJOR OPCIÓN 🔥)\n\n" +
          "Te recomiendo el combo de 5 porque ahorras $15.000.\n\n" +
          "¿Te aparto 5 ahora mismo?"
        );

        // 1 solo recordatorio elegante a los 20 min
        const timeout = setTimeout(async () => {
          await sendText(
            wa_id,
            "👋 Solo paso a confirmar si deseas participar.\n\n" +
            "Puedo apartarte las boletas ahora mismo."
          );
          followUps.delete(wa_id);
        }, 20 * 60 * 1000);

        followUps.set(wa_id, timeout);
        return;
      }

      // Si NO es compra, responde por estado
      if (state === "EN_REVISION") {
        await sendText(wa_id, "🕒 Tu pago está en revisión. Te avisamos al aprobarlo.");
        return;
      }
      if (state === "APROBADO") {
        await sendText(wa_id, "✅ Tu pago fue aprobado. En breve te enviamos tu boleta. 🙌");
        return;
      }
      if (state === "BOLETA_ENVIADA") {
        await sendText(wa_id, "🎟️ Tu boleta ya fue enviada. Si no la ves, dime y te ayudamos.");
        return;
      }

      await sendText(wa_id, "¿Te gustaría participar o conocer precios de boletas?");
      return;
    }

    // IMAGE (filtro publicidad vs comprobante)
    if (type === "image") {
      const mediaId = msg.image?.id;

      // Si OpenAI no está, no bloquea: crea referencia igual
      let cls = { label: "DUDA", confidence: 0, why: "sin IA" };
      try {
        cls = await classifyPaymentImage({ mediaId });
      } catch (e) {
        console.warn("⚠️ Clasificación falló, continúo como DUDA:", e?.message || e);
      }

      console.log("🧠 Clasificación imagen:", cls);

      if (cls.label === "PUBLICIDAD") {
        await sendText(wa_id, "⚠️ Esa imagen parece publicidad. Por favor envíame el *comprobante de pago* (captura del recibo).");
        return;
      }

      if (cls.label !== "COMPROBANTE") {
        await sendText(wa_id, "👀 No logro confirmar si es un comprobante. Por favor envíame una captura clara del *recibo de pago*.");
        return;
      }

      const { ref } = await createReference({
        wa_id,
        last_msg_type: "image",
        receipt_media_id: mediaId,
        receipt_is_payment: "YES",
      });

      await sendText(
        wa_id,
        `✅ Comprobante recibido.\n\n📌 Referencia de pago: ${ref}\n\nTu pago está en revisión.`
      );
      return;
    }

    // DOCUMENT: por ahora pedir imagen (evita PDF/archivos raros)
    if (type === "document") {
      await sendText(wa_id, "📄 Recibí un documento. Por favor envíame el comprobante como *imagen/captura* para procesarlo más rápido.");
      return;
    }

  } catch (err) {
    console.error("❌ /webhook error:", err);
  }
});

// TELEGRAM WEBHOOK (SECRET OBLIGATORIO)
app.post("/telegram-webhook", async (req, res) => {
  try {
    // Secret obligatorio
    if (!TELEGRAM_SECRET_TOKEN) {
      console.error("❌ TELEGRAM_SECRET_TOKEN no está configurado (obligatorio).");
      return res.sendStatus(500);
    }
    const incoming = req.headers["x-telegram-bot-api-secret-token"];
    if (incoming !== TELEGRAM_SECRET_TOKEN) {
      return res.sendStatus(401);
    }

    res.sendStatus(200);

    if (!TELEGRAM_BOT_TOKEN || !sheets) return;

    const msg = req.body?.message;
    if (!msg) return;

    const chat_id = msg.chat?.id;

    // Solo fotos
    const photos = msg.photo;
    const best = Array.isArray(photos) ? photos[photos.length - 1] : null;
    const file_id = best?.file_id;

    const caption = msg.caption || msg.text || "";
    const ref = extractRef(caption);

    if (!file_id) {
      if (chat_id) await telegramSendMessage(chat_id, "⚠️ Debes enviar una *foto* de la boleta.");
      return;
    }
    if (!ref) {
      if (chat_id) await telegramSendMessage(chat_id, "⚠️ Falta la referencia en el caption. Ej: RP-240224-001");
      return;
    }

    const found = await findRowByRef(ref);
    if (!found) {
      if (chat_id) await telegramSendMessage(chat_id, `❌ No encontré esa referencia en la hoja: ${ref}`);
      return;
    }

    // Seguridad: solo enviar si está APROBADO o ya enviada
    if (found.state !== "APROBADO" && found.state !== "BOLETA_ENVIADA") {
      if (chat_id) await telegramSendMessage(chat_id, `⚠️ La referencia ${ref} está en estado: ${found.state}. Primero debe estar APROBADO.`);
      return;
    }

    // Descargar foto de Telegram
    const file_path = await telegramGetFilePath(file_id);
    const imgBuffer = await telegramDownloadFileBuffer(file_path);

    // Subir a WhatsApp y enviar al cliente
    const mediaId = await whatsappUploadImageBuffer(imgBuffer, "image/jpeg");
    await sendImageByMediaId(found.wa_id, mediaId, `🎟️ Boleta enviada ✅ (${ref})`);

    // Marcar estado BOLETA_ENVIADA
    if (found.state !== "BOLETA_ENVIADA") {
      await updateCell(`D${found.rowNumber}`, "BOLETA_ENVIADA");
    }

    if (chat_id) await telegramSendMessage(chat_id, `✅ Envié la boleta al cliente (${found.wa_id}) y marqué BOLETA_ENVIADA. (${ref})`);
  } catch (err) {
    console.error("❌ /telegram-webhook error:", err);
    // Si falló antes de responder 200, Telegram reintentará; aquí ya respondimos arriba.
  }
});

/* ================= START ================= */

setInterval(monitorAprobados, 30000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});