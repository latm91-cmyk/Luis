const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "rifas_verify_123";

// ===== Google Sheets config =====
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB_NAME = process.env.GOOGLE_SHEET_TAB || "cases"; // pestaña en la hoja

const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// Crea cliente de Sheets solo si hay env vars (para evitar crasheo si falta algo)
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
  // Asumimos headers en fila 1; si no tienes headers, igual funciona (solo empieza en 0)
  let lastState = "BOT";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowWa = row?.[2];    // Col C: wa_id
    const rowState = row?.[3]; // Col D: state
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
    // Si no hay Sheets, igual devolvemos un case_id para logs
    const case_id = `CASE-${todayYYMMDD()}-000`;
    return { case_id, state: "EN_REVISION" };
  }

  const max = await getLastCaseNumberForToday();
  const next = String(max + 1).padStart(3, "0");
  const case_id = `CASE-${todayYYMMDD()}-${next}`;

  const created_at = new Date().toISOString();
  const state = "EN_REVISION";

  // Columnas A:I (8 columnas usadas aquí)
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:I`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        created_at,                // A created_at
        case_id,                   // B case_id
        wa_id,                     // C wa_id
        state,                     // D state
        last_msg_type,             // E last_msg_type
        receipt_media_id || "",    // F receipt_media_id
        receipt_is_payment || "UNKNOWN", // G receipt_is_payment
        "",                        // H notes
      ]],
    },
  });

  return { case_id, state };
}

// ===== Health check =====
app.get("/", (req, res) => {
  res.send("OK - webhook vivo ✅");
});

// ===== Test Sheets: escribe una fila =====
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
  // Responder rápido a Meta
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];

    console.log("📩 Evento recibido:");
    console.log(JSON.stringify(req.body, null, 2));

    // A veces llegan status updates sin messages
    if (!msg) return;

    const wa_id = msg.from;   // número del cliente
    const type = msg.type;    // "text", "image", "document", etc.

    // 1) Si ya está en revisión => BOT NO RESPONDE
    const state = await getLatestStateByWaId(wa_id);
    if (state === "EN_REVISION") {
      console.log("🛑 Bot detenido (EN_REVISION) para:", wa_id);
      return;
    }

    // 2) Si llega imagen o documento => crear caso + marcar EN_REVISION
    if (type === "image" || type === "document") {
      const receipt_media_id =
        type === "image" ? msg.image?.id :
        type === "document" ? msg.document?.id :
        "";

      // Aquí después puedes poner clasificación con IA: YES/NO/UNKNOWN
      const receipt_is_payment = "UNKNOWN";

      const { case_id } = await createCase({
        wa_id,
        last_msg_type: type,
        receipt_media_id,
        receipt_is_payment,
      });

      console.log("✅ Caso creado y bot detenido:", { case_id, wa_id, type, receipt_media_id });

      // Si más adelante tienes envío activo (Cloud o WhatsApp Web), aquí enviarías:
      // "✅ Comprobante recibido. Caso X. En revisión."
      return;
    }

    // 3) Si es texto => aquí entra BuilderBot (por ahora solo log)
    const text = msg.text?.body || "";
    console.log("🤖 Texto para IA (BuilderBot):", { wa_id, text });

    // TODO: integrar BuilderBot aquí
    // - generar respuesta
    // - (si tienes canal de envío habilitado) enviar al usuario

  } catch (err) {
    console.error("❌ Webhook processing error:", err);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});