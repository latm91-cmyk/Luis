const express = require("express");
const { google } = require("googleapis");
const fetch = require("node-fetch");
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

/* ==========================
   CONFIG
========================== */

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "rifas_verify_123";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

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
}

/* ==========================
   UTILIDADES
========================== */

function verifyMetaSignature(req) {
  const appSecret = process.env.META_APP_SECRET;
  const signature = req.headers["x-hub-signature-256"];
  if (!appSecret || !signature || !req.rawBody) return true;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

async function sendText(to, bodyText) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  await fetch(url, {
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
}

async function getAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:H`,
  });
  return res.data.values || [];
}

/* ==========================
   CREAR CASE
========================== */

function todayYYMMDD() {
  const d = new Date();
  return (
    String(d.getFullYear()).slice(-2) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0")
  );
}

async function getLastCaseNumberForToday() {
  const rows = await getAllRows();
  const prefix = `CASE-${todayYYMMDD()}-`;
  let max = 0;

  rows.forEach(row => {
    const id = row?.[1] || "";
    if (id.startsWith(prefix)) {
      const n = parseInt(id.replace(prefix, ""), 10);
      if (!isNaN(n)) max = Math.max(max, n);
    }
  });

  return max;
}

async function createCase(wa_id, type, media_id) {
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

/* ==========================
   MONITOR AUTOMÁTICO APROBADO
========================== */

async function monitorAprobados() {
  try {
    if (!sheets) return;

    const rows = await getAllRows();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const case_id = row?.[1];
      const wa_id = row?.[2];
      const state = row?.[3];
      const notes = row?.[7];

      if (state === "APROBADO" && notes !== "NOTIFIED_APROBADO") {
        console.log("🔔 Detectado APROBADO:", case_id);

        await sendText(
          wa_id,
          "✅ Tu pago fue aprobado. En breve te enviamos tu boleta. 🙌"
        );

        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${TAB_NAME}!H${i + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [["NOTIFIED_APROBADO"]],
          },
        });

        console.log("✅ Notificado y marcado.");
      }
    }
  } catch (err) {
    console.error("Error monitor:", err);
  }
}

/* ==========================
   WEBHOOK META
========================== */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const wa_id = msg.from;
  const type = msg.type;

  const rows = await getAllRows();
  const last = rows.filter(r => r?.[2] === wa_id).pop();
  const state = last?.[3];

  if (state === "EN_REVISION") {
    await sendText(wa_id, "🕒 Tu comprobante está en revisión.");
    return;
  }
  if (state === "APROBADO") {
    await sendText(wa_id, "✅ Pago aprobado. En breve enviamos tu boleta.");
    return;
  }
  if (state === "BOLETA_ENVIADA") {
    await sendText(wa_id, "🎟️ Tu boleta ya fue enviada.");
    return;
  }

  if (type === "image" || type === "document") {
    const media_id =
      type === "image" ? msg.image?.id : msg.document?.id;

    const case_id = await createCase(wa_id, type, media_id);

    await sendText(
      wa_id,
      `✅ Comprobante recibido. Caso ${case_id}. En revisión.`
    );
    return;
  }

  await sendText(wa_id, "¿En qué puedo ayudarte?");
});

/* ==========================
   INICIO SERVIDOR
========================== */

setInterval(monitorAprobados, 30000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Servidor corriendo en puerto " + PORT);
});