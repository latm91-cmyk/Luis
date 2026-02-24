const express = require("express");
const { google } = require("googleapis");
const fetch = require("node-fetch"); // node-fetch@2
const crypto = require("crypto");
const FormData = require("form-data"); // npm i form-data

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
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN || ""; // recomendado (opcional)

let sheets = null;
if (SHEET_ID && GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY) {
  const auth = new google.auth.JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });
} else {
  console.warn("⚠️ Google Sheets NO configurado. Revisa env vars.");
}

/* ================= MEMORIA FOLLOW-UP (1 SOLO INTENTO) ================= */

const followUps = new Map();

/* ================= UTIL SEGURIDAD META ================= */

function verifyMetaSignature(req) {
  const appSecret = process.env.META_APP_SECRET;
  const signature = req.headers["x-hub-signature-256"];
  if (!appSecret) return true; // si no está, no bloquea
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

/* ================= WHATSAPP SEND ================= */

async function sendText(to, bodyText) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.warn("⚠️ Faltan WHATSAPP_TOKEN o PHONE_NUMBER_ID");
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

  const raw = await resp.text();
  return { ok: resp.ok, status: resp.status, raw };
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
  if (!resp.ok) {
    throw new Error(`Upload media fallo: ${resp.status} ${JSON.stringify(data)}`);
  }
  return data.id; // media_id de WhatsApp
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

  const raw = await resp.text();
  return { ok: resp.ok, status: resp.status, raw };
}

/* ================= SHEETS HELPERS ================= */

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

async function findRowByCaseId(case_id) {
  const rows = await getAllRowsAtoH();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row?.[1] === case_id) {
      return {
        rowIndex0: i,          // índice 0-based en el array rows
        rowNumber: i + 1,      // número real en Sheets
        created_at: row?.[0] || "",
        case_id: row?.[1] || "",
        wa_id: row?.[2] || "",
        state: row?.[3] || "",
        notes: row?.[7] || "",
      };
    }
  }
  return null;
}

async function updateStateByRowNumber(rowNumber, newState) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!D${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newState]] },
  });
}

async function updateNotesByRowNumber(rowNumber, noteValue) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!H${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[noteValue]] },
  });
}

/* ================= CASE CREATION ================= */

function todayYYMMDD() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

async function getLastCaseNumberForToday() {
  const rows = await getAllRowsAtoH();
  const prefix = `CASE-${todayYYMMDD()}-`;
  let max = 0;
  for (let i = 1; i < rows.length; i++) {
    const id = rows[i]?.[1] || "";
    if (id.startsWith(prefix)) {
      const n = parseInt(id.replace(prefix, ""), 10);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    }
  }
  return max;
}

async function createCase(wa_id, type, media_id) {
  if (!sheets) return `CASE-${todayYYMMDD()}-000`;

  const max = await getLastCaseNumberForToday();
  const next = String(max + 1).padStart(3, "0");
  const case_id = `CASE-${todayYYMMDD()}-${next}`;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        new Date().toISOString(),
        case_id,
        wa_id,
        "EN_REVISION",
        type,
        media_id || "",
        "UNKNOWN",
        ""
      ]],
    },
  });

  return case_id;
}

/* ================= VENTAS: INTENCIÓN + 1 FOLLOW-UP ================= */

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

/* ================= MONITOR APROBADOS (AUTO) ================= */

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
        await updateNotesByRowNumber(i + 1, "NOTIFIED_APROBADO");
      }
    }
  } catch (err) {
    console.error("❌ monitorAprobados error:", err);
  }
}

/* ================= HEALTH ================= */

app.get("/", (req, res) => res.send("OK ✅"));

/* ================= META VERIFY ================= */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ================= META WEBHOOK ================= */

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

    // Si es texto: primero intención de compra
    if (type === "text") {
      const text = msg.text?.body || "";

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

      // Si NO es compra, entonces responde por estado
      const state = await getLatestStateByWaId(wa_id);

      if (state === "EN_REVISION") return void (await sendText(wa_id, "🕒 Tu comprobante está en revisión. Te avisamos al aprobarlo."));
      if (state === "APROBADO") return void (await sendText(wa_id, "✅ ¡Pago aprobado! En breve te enviamos tu boleta por este WhatsApp. 🙌"));
      if (state === "BOLETA_ENVIADA") return void (await sendText(wa_id, "🎟️ Tu boleta ya fue enviada. Si no la ves, dime y te ayudamos."));
      if (state === "RECHAZADO") return void (await sendText(wa_id, "⚠️ Tu pago fue rechazado. Por favor envía de nuevo el comprobante o confirma los datos."));

      return void (await sendText(wa_id, "¿Te gustaría participar o conocer precios de boletas?"));
    }

    // Si llega comprobante: crear CASE
    if (type === "image" || type === "document") {
      const media_id = type === "image" ? msg.image?.id : msg.document?.id;
      const case_id = await createCase(wa_id, type, media_id);
      await sendText(wa_id, `✅ Comprobante recibido. Caso ${case_id}. En revisión.`);
      return;
    }
  } catch (err) {
    console.error("❌ /webhook error:", err);
  }
});

/* ================= TELEGRAM HELPERS ================= */

function extractCaseId(text = "") {
  const m = String(text).match(/CASE-[A-Za-z0-9-]+/i);
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

/* ================= TELEGRAM WEBHOOK ================= */

app.post("/telegram-webhook", async (req, res) => {
  // Seguridad opcional: si configuras TELEGRAM_SECRET_TOKEN en setWebhook
  if (TELEGRAM_SECRET_TOKEN) {
    const incoming = req.headers["x-telegram-bot-api-secret-token"];
    if (incoming !== TELEGRAM_SECRET_TOKEN) return res.sendStatus(401);
  }

  res.sendStatus(200);

  try {
    if (!TELEGRAM_BOT_TOKEN) return;

    const msg = req.body?.message;
    if (!msg) return;

    const chat_id = msg.chat?.id;
    const caption = msg.caption || msg.text || "";
    const case_id = extractCaseId(caption);

    // Solo fotos (como me dijiste)
    const photos = msg.photo;
    const best = Array.isArray(photos) ? photos[photos.length - 1] : null;
    const file_id = best?.file_id;

    if (!file_id) {
      if (chat_id) await telegramSendMessage(chat_id, "⚠️ Debes enviar una *foto* de la boleta.");
      return;
    }

    if (!case_id) {
      if (chat_id) await telegramSendMessage(chat_id, "⚠️ Falta el código del caso en el caption. Ej: CASE-240224-001");
      return;
    }

    const found = await findRowByCaseId(case_id);
    if (!found) {
      if (chat_id) await telegramSendMessage(chat_id, `❌ No encontré ese CASE en la hoja: ${case_id}`);
      return;
    }

    // Recomendado: solo permitir envío si está APROBADO
    if (found.state !== "APROBADO" && found.state !== "BOLETA_ENVIADA") {
      if (chat_id) await telegramSendMessage(chat_id, `⚠️ El caso ${case_id} está en estado: ${found.state}. Primero debe estar APROBADO.`);
      return;
    }

    // Descargar foto de Telegram
    const file_path = await telegramGetFilePath(file_id);
    const imgBuffer = await telegramDownloadFileBuffer(file_path);

    // Subir a WhatsApp y enviar al cliente
    const mediaId = await whatsappUploadImageBuffer(imgBuffer, "image/jpeg");
    await sendImageByMediaId(found.wa_id, mediaId, `🎟️ Boleta enviada ✅ (${case_id})`);

    // Marcar estado BOLETA_ENVIADA (opcional pero recomendado)
    if (found.state !== "BOLETA_ENVIADA") {
      await updateStateByRowNumber(found.rowNumber, "BOLETA_ENVIADA");
    }

    if (chat_id) await telegramSendMessage(chat_id, `✅ Envié la boleta al cliente (${found.wa_id}) y marqué BOLETA_ENVIADA. (${case_id})`);
  } catch (err) {
    console.error("❌ /telegram-webhook error:", err);
  }
});

/* ================= START ================= */

setInterval(monitorAprobados, 30000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));