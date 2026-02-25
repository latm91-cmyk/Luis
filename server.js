// server.js
const express = require("express");
const { google } = require("googleapis");
const fetch = require("node-fetch"); // npm i node-fetch@2
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();

// ====== ENV ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "rifas_verify_123";
const META_APP_SECRET = process.env.META_APP_SECRET; // OBLIGATORIO
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // OBLIGATORIO para enviar
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // OBLIGATORIO para enviar
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ===== Google Sheets config =====
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CASES_TAB = process.env.GOOGLE_SHEET_TAB || "cases";
const CONV_TAB = process.env.GOOGLE_SHEET_CONV_TAB || "conversations";

const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

let sheets = null;
if (SHEET_ID && GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY) {
  const auth = new google.auth.JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });
} else {
  console.warn("⚠️ Google Sheets NO configurado. Revisa env vars: GOOGLE_SHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY");
}

// ===== OpenAI =====
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ===== Middleware: guardar raw body para firma Meta =====
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ====== Seguridad Meta (OBLIGATORIA) ======
function verifyMetaSignature(req) {
  // Si NO hay secreto, bloqueamos (seguridad obligatoria)
  if (!META_APP_SECRET) {
    console.error("❌ META_APP_SECRET NO configurado. Bloqueando webhook por seguridad.");
    return false;
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");

  // timingSafeEqual requiere buffers del mismo largo
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ===== Helpers =====
function todayYYMMDD() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function isThanks(text = "") {
  const t = text.toLowerCase().trim();
  return (
    t === "gracias" ||
    t === "gracias!" ||
    t === "muchas gracias" ||
    t === "mil gracias" ||
    t.includes("gracias")
  );
}

// ===== Guardar conversación en Sheet conversations =====
async function saveConversation({ wa_id, direction, message, ref_id = "" }) {
  if (!sheets) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CONV_TAB}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[new Date().toISOString(), wa_id, direction, message, ref_id]],
    },
  });
}

// ===== Estado actual por wa_id (último state en cases) =====
async function getLatestStateByWaId(wa_id) {
  if (!sheets) return "BOT";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${CASES_TAB}!A:I`,
  });

  const rows = res.data.values || [];
  let lastState = "BOT";

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowWa = row?.[2]; // C wa_id
    const rowState = row?.[3]; // D state
    if (rowWa === wa_id && rowState) lastState = rowState;
  }
  return lastState;
}

async function getLastRefNumberForToday() {
  if (!sheets) return 0;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${CASES_TAB}!B:B`, // Col B: ref_id
  });

  const values = res.data.values || [];
  const prefix = `REF-${todayYYMMDD()}-`;
  let max = 0;

  for (const row of values) {
    const id = row?.[0] || "";
    if (id.startsWith(prefix)) {
      const n = parseInt(id.replace(prefix, ""), 10);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    }
  }
  return max;
}

// ===== Crear referencia (antes "case") =====
async function createReference({ wa_id, last_msg_type, receipt_media_id, receipt_is_payment }) {
  if (!sheets) {
    const ref_id = `REF-${todayYYMMDD()}-000`;
    return { ref_id, state: "EN_REVISION" };
  }

  const max = await getLastRefNumberForToday();
  const next = String(max + 1).padStart(3, "0");
  const ref_id = `REF-${todayYYMMDD()}-${next}`;

  const created_at = new Date().toISOString();
  const state = "EN_REVISION";

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CASES_TAB}!A:I`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        created_at,               // A created_at
        ref_id,                  // B ref_id
        wa_id,                   // C wa_id
        state,                   // D state
        last_msg_type,           // E last_msg_type
        receipt_media_id || "",  // F receipt_media_id
        receipt_is_payment || "UNKNOWN", // G receipt_is_payment
        "",                      // H notes
      ]],
    },
  });

  return { ref_id, state };
}

// ===== WhatsApp Send =====
async function sendText(to, bodyText, ref_id = "") {
  if (!WHATSAPP_TOKEN) {
    console.warn("⚠️ WHATSAPP_TOKEN NO configurado");
    return { ok: false, reason: "missing_whatsapp_token" };
  }
  if (!PHONE_NUMBER_ID) {
    console.warn("⚠️ PHONE_NUMBER_ID NO configurado");
    return { ok: false, reason: "missing_phone_number_id" };
  }

  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: bodyText },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  console.log("📤 WhatsApp send status:", resp.status);
  console.log("📤 WhatsApp send raw:", raw);

  // Guardar conversación OUT
  await saveConversation({
    wa_id: to,
    direction: "OUT",
    message: bodyText,
    ref_id,
  });

  return { ok: resp.ok, status: resp.status, raw };
}

// ===== OpenAI respuesta =====
async function askOpenAI(userText, state = "BOT") {
  if (!openai) return "⚠️ IA no configurada.";

  const systemPrompt = `
Eres un asistente de WhatsApp para Rifas El Agropecuario.
Responde corto, claro, en español colombiano, amigable y orientado a cerrar venta.
Reglas:
- Si el usuario dice "gracias", responde con agradecimiento y cierra elegante.
- No inventes datos.
- Si el usuario pregunta precio, explica opciones en frases cortas.
- Si el estado es EN_REVISION, recuerda que ya está en revisión.
Estado actual del cliente: ${state}
`.trim();

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
  });

  return (resp.output_text || "").trim() || "¿Me repites, por favor?";
}

// ===== Routes =====
app.get("/", (req, res) => res.send("OK - webhook vivo ✅"));

// Test send
app.get("/test-send", async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).send("Falta ?to=573xxxxxxxxx");
  const result = await sendText(to, "✅ TEST desde /test-send");
  return res.status(200).send(result);
});

// Test AI
app.get("/test-ai", async (req, res) => {
  const q = req.query.q || "hola";
  const out = await askOpenAI(q, "BOT");
  return res.json({ ok: true, q, out });
});

// Test sheet
app.get("/test-sheet", async (req, res) => {
  try {
    if (!sheets) return res.status(500).send("Sheets NO configurado (revisa env vars)");
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${CONV_TAB}!A:E`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[new Date().toISOString(), "TEST", "OUT", "TEST_OK", ""]] },
    });
    return res.status(200).send("OK: escribí en conversations ✅");
  } catch (err) {
    console.error("❌ Sheets error:", err?.response?.data || err);
    return res.status(500).send("ERROR: revisa logs en Render");
  }
});

// ===== Meta verify =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== WhatsApp webhook receive =====
app.post("/webhook", async (req, res) => {
  // Seguridad obligatoria
  if (!verifyMetaSignature(req)) {
    console.log("❌ Firma Meta inválida - bloqueado");
    return res.sendStatus(403);
  }

  // Responder rápido
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];

    console.log("📩 Evento recibido");
    // console.log(JSON.stringify(req.body, null, 2)); // si quieres ver todo

    if (!msg) return; // statuses u otros eventos

    const wa_id = msg.from;
    const type = msg.type;

    // ===== TEXT =====
    if (type === "text") {
      const text = msg.text?.body || "";

      // Guardar IN
      await saveConversation({
        wa_id,
        direction: "IN",
        message: text,
      });

      const state = await getLatestStateByWaId(wa_id);

      // Si está en revisión, mensaje corto
      if (state === "EN_REVISION") {
        await sendText(wa_id, "🕒 Tu comprobante ya está en revisión. Apenas sea aprobado te avisamos.", "");
        return;
      }

      // Si dice gracias
      if (isThanks(text)) {
        await sendText(wa_id, "¡Con gusto! 🙌 Gracias por tu compra. Si necesitas otra boleta, me dices y te ayudo.", "");
        return;
      }

      // IA normal
      const aiReply = await askOpenAI(text, state);
      await sendText(wa_id, aiReply, "");
      return;
    }

    // ===== IMAGE / DOCUMENT =====
    if (type === "image" || type === "document") {
      // Guardar IN (nota)
      await saveConversation({
        wa_id,
        direction: "IN",
        message: `[${type}] recibido`,
      });

      const state = await getLatestStateByWaId(wa_id);
      if (state === "EN_REVISION") {
        await sendText(wa_id, "🕒 Ya tenemos tu comprobante en revisión. Si enviaste otro por error, no te preocupes.", "");
        return;
      }

      const receipt_media_id =
        type === "image" ? msg.image?.id :
        type === "document" ? msg.document?.id :
        "";

      // Aquí a futuro puedes hacer clasificación real (publicidad vs comprobante).
      // Por ahora dejamos UNKNOWN para no frenar flujo.
      const receipt_is_payment = "UNKNOWN";

      const { ref_id } = await createReference({
        wa_id,
        last_msg_type: type,
        receipt_media_id,
        receipt_is_payment,
      });

      console.log("✅ Referencia creada:", { ref_id, wa_id, type, receipt_media_id });

      await sendText(wa_id, `✅ Comprobante recibido. Referencia ${ref_id}. En revisión.`, ref_id);
      return;
    }

    // Otros tipos
    console.log("ℹ️ Tipo no manejado aún:", type);
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
  }
});

// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));