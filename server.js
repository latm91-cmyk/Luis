const express = require("express");
const { google } = require("googleapis");
const fetch = require("node-fetch"); // npm i node-fetch@2
const crypto = require("crypto");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();

/**
 * Guardar raw body para validar firma de Meta
 */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 * Verifica que el POST venga realmente de Meta
 */
function verifyMetaSignature(req) {
  const appSecret = process.env.META_APP_SECRET;
  const signature = req.headers["x-hub-signature-256"];

  // Si no configuras META_APP_SECRET, no bloqueamos (pero queda menos seguro)
  if (!appSecret) {
    console.warn("⚠️ META_APP_SECRET no configurado. (Seguridad desactivada)");
    return true;
  }

  if (!signature || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "utf8"),
      Buffer.from(expected, "utf8")
    );
  } catch {
    return false;
  }
}

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "rifas_verify_123";

// ===== Google Sheets config =====
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB_NAME = process.env.GOOGLE_SHEET_TAB || "cases";

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
  console.warn(
    "⚠️ Google Sheets NO configurado. Revisa env vars: GOOGLE_SHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY"
  );
}

function todayYYMMDD() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

async function getLatestStateByWaId(wa_id) {
  if (!sheets) return "BOT";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:I`,
  });

  const rows = res.data.values || [];
  let lastState = "BOT";

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowWa = row?.[2];     // Col C: wa_id
    const rowState = row?.[3];  // Col D: state
    if (rowWa === wa_id && rowState) lastState = rowState;
  }
  return lastState;
}

async function getLastCaseNumberForToday() {
  if (!sheets) return 0;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!B:B`, // Col B: case_id
  });

  const values = res.data.values || [];
  const prefix = `CASE-${todayYYMMDD()}-`;
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

async function createCase({ wa_id, last_msg_type, receipt_media_id, receipt_is_payment }) {
  if (!sheets) {
    const case_id = `CASE-${todayYYMMDD()}-000`;
    return { case_id, state: "EN_REVISION" };
  }

  const max = await getLastCaseNumberForToday();
  const next = String(max + 1).padStart(3, "0");
  const case_id = `CASE-${todayYYMMDD()}-${next}`;

  const created_at = new Date().toISOString();
  const state = "EN_REVISION";

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:I`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        created_at,                      // A created_at
        case_id,                         // B case_id
        wa_id,                           // C wa_id
        state,                           // D state
        last_msg_type,                   // E last_msg_type
        receipt_media_id || "",          // F receipt_media_id
        receipt_is_payment || "UNKNOWN", // G receipt_is_payment
        "",                              // H notes
      ]],
    },
  });

  return { case_id, state };
}

// ===== WhatsApp Send =====
async function sendText(to, bodyText) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  if (!token) {
    console.warn("⚠️ WHATSAPP_TOKEN NO configurado en Render");
    return { ok: false, reason: "missing_token" };
  }
  if (!phoneNumberId) {
    console.warn("⚠️ PHONE_NUMBER_ID NO configurado en Render");
    return { ok: false, reason: "missing_phone_number_id" };
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: bodyText },
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const raw = await resp.text();
    console.log("📤 WhatsApp send status:", resp.status);
    console.log("📤 WhatsApp send raw:", raw);

    return { ok: resp.ok, status: resp.status, raw };
  } catch (err) {
    console.error("❌ Error en fetch (sendText):", err);
    return { ok: false, reason: "fetch_error", error: String(err) };
  }
}

// ===== OpenAI helper =====
async function askOpenAI(userText) {
  if (!process.env.OPENAI_API_KEY) {
    return "⚠️ IA no configurada (falta OPENAI_API_KEY en Render).";
  }

  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "Eres un asistente de WhatsApp para Rifas el Agropecuario. Responde corto, claro y en español. Si preguntan cómo comprar, explica pasos. Si no entiendes, pregunta una sola cosa.",
        },
        { role: "user", content: userText },
      ],
    });

    return (resp.output_text || "").trim() || "¿Me repites, por favor?";
  } catch (err) {
    console.error("❌ OpenAI error:", err?.message || err);
    return "⚠️ Estoy teniendo problemas con la IA. Intenta de nuevo en un momento.";
  }
}

// ===== Health check =====
app.get("/", (req, res) => {
  res.send("OK - webhook vivo ✅");
});

// ===== Test send =====
// Ejemplo: /test-send?to=573125558821
app.get("/test-send", async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).send("Falta ?to=573xxxxxxxxx");

  const result = await sendText(to, "✅ TEST desde /test-send (Render)");
  return res.status(200).send(result);
});

// ===== Test IA =====
// Ejemplo: /test-ai?q=hola
app.get("/test-ai", async (req, res) => {
  const q = req.query.q || "hola";
  const r = await askOpenAI(q);
  res.send({ q, r });
});

// ===== Test Sheets =====
app.get("/test-sheet", async (req, res) => {
  try {
    if (!sheets) return res.status(500).send("Sheets NO configurado (revisa env vars)");

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${TAB_NAME}!A:A`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[new Date().toISOString(), "TEST_OK"]] },
    });

    return res.status(200).send("OK: escribí en Sheets ✅");
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

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ===== Webhook receive =====
app.post("/webhook", async (req, res) => {
  // Seguridad: solo Meta
  if (!verifyMetaSignature(req)) {
    console.log("❌ Firma inválida - bloqueado");
    return res.sendStatus(403);
  }

  // Responder rápido a Meta
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];

    // A veces llegan status updates sin messages
    if (!msg) return;

    const wa_id = msg.from;
    const type = msg.type;

    const state = await getLatestStateByWaId(wa_id);
    console.log("🧭 Estado actual:", { wa_id, state, type });

    // Si está EN_REVISION, responde corto y no llama IA
    if (state === "EN_REVISION") {
      await sendText(wa_id, "🕒 Tu caso sigue en revisión. Apenas sea aprobado te avisamos.");
      return;
    }

    // Imagen/Documento -> crear caso + responder (sin IA)
    if (type === "image" || type === "document") {
      const receipt_media_id =
        type === "image" ? msg.image?.id :
        type === "document" ? msg.document?.id :
        "";

      const receipt_is_payment = "UNKNOWN";

      const { case_id } = await createCase({
        wa_id,
        last_msg_type: type,
        receipt_media_id,
        receipt_is_payment,
      });

      console.log("✅ Caso creado:", { case_id, wa_id, type, receipt_media_id });
      await sendText(wa_id, `✅ Comprobante recibido. Caso ${case_id}. En revisión.`);
      return;
    }

    // Texto -> IA -> WhatsApp
    if (type === "text") {
      const text = msg.text?.body || "";
      console.log("🤖 Texto recibido:", { wa_id, text });

      const aiReply = await askOpenAI(text);
      await sendText(wa_id, aiReply);
      return;
    }

    console.log("ℹ️ Tipo no manejado aún:", type);
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});