const express = require("express");
const { google } = require("googleapis");
const fetch = require("node-fetch"); // npm i node-fetch@2
const crypto = require("crypto");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();

/** ===== Raw body para validar firma Meta ===== */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

function verifyMetaSignature(req) {
  const appSecret = process.env.META_APP_SECRET;
  const signature = req.headers["x-hub-signature-256"];

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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // <- ponlo en Render (secreto)

// ===== Prompt híbrido =====
const SYSTEM_PROMPT = `
Eres el asistente oficial de WhatsApp de "Rifas y Sorteos El Agropecuario" (Colombia).
Objetivo: ayudar a vender boletas y guiar al cliente hasta enviar comprobante, con respuestas cortas y claras.

REGLAS:
- Español, tono cercano y profesional.
- 1 a 3 frases. 1 pregunta a la vez.
- NO inventes datos (precios, fechas, premios, cuentas).
- No pidas datos sensibles.
- Si va a pagar o pagó: pide comprobante (foto/PDF) + datos.

INFO:
- Atención: 8:30 am a 7:30 pm.
- Pago: Nequi 3223146142 / Daviplata 3223146142.
- Datos: Nombre, Teléfono, Municipio, Cantidad boletas.
`.trim();

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
  console.warn("⚠️ Google Sheets NO configurado. Revisa env vars.");
}

function todayYYMMDD() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Lee toda la hoja una vez por consulta (simple).
 * Si creces mucho, luego optimizamos con rangos o cache.
 */
async function getAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:Z`,
  });
  return res.data.values || [];
}

async function getLatestStateByWaId(wa_id) {
  if (!sheets) return "BOT";
  const rows = await getAllRows();

  let lastState = "BOT";
  for (const row of rows) {
    const rowWa = row?.[2]; // C
    const rowState = row?.[3]; // D
    if (rowWa === wa_id && rowState) lastState = rowState;
  }
  return lastState;
}

async function getLastCaseNumberForToday() {
  if (!sheets) return 0;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!B:B`,
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

  // A:H (8 cols)
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        created_at,                 // A created_at
        case_id,                    // B case_id
        wa_id,                      // C wa_id
        state,                      // D state
        last_msg_type,              // E last_msg_type
        receipt_media_id || "",     // F receipt_media_id
        receipt_is_payment || "UNKNOWN", // G receipt_is_payment
        "",                         // H notes
      ]],
    },
  });

  return { case_id, state };
}

// ===== WhatsApp Send =====
async function sendText(to, bodyText) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.warn("⚠️ Faltan WHATSAPP_TOKEN o PHONE_NUMBER_ID en Render");
    return { ok: false };
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: bodyText },
  };

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
  return { ok: resp.ok, status: resp.status, raw };
}

// ===== OpenAI helper =====
async function askOpenAI(userText) {
  if (!process.env.OPENAI_API_KEY) return "⚠️ IA no configurada.";

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
  });

  return (resp.output_text || "").trim() || "¿Me repites, por favor?";
}

// ===== Reglas: precios + “ya pagué” =====
function formatCOP(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString("es-CO");
}

function calcTotalCOPForBoletas(n) {
  const P1 = 15000, P2 = 25000, P5 = 60000;
  const qty = Number(n);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  let remaining = Math.floor(qty);
  const packs5 = Math.floor(remaining / 5); remaining %= 5;
  const packs2 = Math.floor(remaining / 2); remaining %= 2;
  const packs1 = remaining;

  const total = packs5 * P5 + packs2 * P2 + packs1 * P1;
  return { qty, total, packs5, packs2, packs1 };
}

function tryExtractBoletasQty(text = "") {
  const t = String(text).toLowerCase();
  const m1 = t.match(/(\d{1,4})\s*(boletas?|boletos?)/i);
  if (m1) return parseInt(m1[1], 10);
  const m2 = t.match(/(?:quiero|comprar|llevar|dame|necesito)\s*(\d{1,4})/i);
  if (m2) return parseInt(m2[1], 10);
  const m3 = t.trim().match(/^(\d{1,4})$/);
  if (m3) return parseInt(m3[1], 10);
  return null;
}

function isPricingIntent(text = "") {
  const t = String(text).toLowerCase();
  return (
    t.includes("precio") ||
    t.includes("valor") ||
    t.includes("cuanto") ||
    t.includes("cuánto") ||
    t.includes("vale") ||
    t.includes("costo") ||
    t.includes("boleta") ||
    t.includes("boletas") ||
    t.includes("boleto") ||
    t.includes("boletos")
  );
}

function isAlreadyPaidIntent(text = "") {
  const t = String(text).toLowerCase();
  return (
    t.includes("ya pag") ||
    t.includes("ya hice el pago") ||
    t.includes("ya realic") ||
    t.includes("ya transfer") ||
    t.includes("ya consign") ||
    t.includes("ya envié el comprobante") ||
    t.includes("ya envie el comprobante") ||
    t.includes("te envié el comprobante") ||
    t.includes("te envie el comprobante") ||
    t.includes("soporte de pago")
  );
}

function paidInstructionMessage() {
  return (
    "✅ Perfecto. Envíame el *comprobante* (foto o PDF) y estos datos:\n" +
    "- Nombre completo\n- Teléfono\n- Municipio\n- Cantidad de boletas\n\n" +
    "Apenas lo recibamos queda *en revisión* y te confirmamos."
  );
}

function pricingReplyMessage(qty, breakdown) {
  const { total, packs5, packs2, packs1 } = breakdown;
  const parts = [];
  if (packs5) parts.push(`${packs5}×(5)`);
  if (packs2) parts.push(`${packs2}×(2)`);
  if (packs1) parts.push(`${packs1}×(1)`);

  return (
    `✅ Para *${qty}* boleta(s), el total es *$${formatCOP(total)} COP*.\n` +
    `(Combo: ${parts.join(" + ")})\n` +
    "¿Deseas pagar por *Nequi* o *Daviplata*?"
  );
}

// ===== Mini-memoria simple =====
const convo = new Map();
const CONVO_TTL_MS = 24 * 60 * 60 * 1000;

function getConvo(wa_id) {
  const c = convo.get(wa_id);
  if (!c) return null;
  if (Date.now() - (c.updatedAt || 0) > CONVO_TTL_MS) {
    convo.delete(wa_id);
    return null;
  }
  return c;
}
function setConvo(wa_id, patch) {
  const prev = convo.get(wa_id) || {};
  convo.set(wa_id, { ...prev, ...patch, updatedAt: Date.now() });
}
function clearConvo(wa_id) { convo.delete(wa_id); }

function isPayMethod(text = "") {
  const t = String(text).toLowerCase();
  if (t.includes("nequi")) return "NEQUI";
  if (t.includes("davi")) return "DAVIPLATA";
  return null;
}
function looksLikeBuyIntent(text = "") {
  const t = String(text).toLowerCase();
  return t.includes("comprar") || t.includes("participar") || t.includes("bolet");
}

// ===== Utilidad: buscar por CASE (para Telegram bot) =====
async function findCaseRowByCaseId(case_id) {
  if (!sheets) return null;
  const rows = await getAllRows();
  // Asumimos headers NO o que están en la primera fila; igual buscamos en todas
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowCaseId = row?.[1]; // B
    if (rowCaseId === case_id) {
      const wa_id = row?.[2] || "";
      const state = row?.[3] || "";
      return { rowIndex0: i, wa_id, state };
    }
  }
  return null;
}

async function updateCaseStateByRowIndex(rowIndex0, newState) {
  if (!sheets) return false;
  const rowNumber = rowIndex0 + 1; // Sheets es 1-based
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!D${rowNumber}`, // Col D = state
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newState]] },
  });
  return true;
}

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    return res.status(500).send({ ok: false, error: "ADMIN_TOKEN no configurado" });
  }
  const h = req.headers["x-admin-token"];
  if (!h || h !== ADMIN_TOKEN) {
    return res.status(401).send({ ok: false, error: "No autorizado" });
  }
  return null;
}

// ===== Health =====
app.get("/", (req, res) => res.send("OK - webhook vivo ✅"));

// ===== Endpoint para Telegram bot: consultar case =====
// GET /case?case_id=CASE-YYMMDD-001
app.get("/case", async (req, res) => {
  const block = requireAdmin(req, res);
  if (block) return;

  const case_id = req.query.case_id;
  if (!case_id) return res.status(400).send({ ok: false, error: "Falta case_id" });

  const found = await findCaseRowByCaseId(case_id);
  if (!found) return res.status(404).send({ ok: false, error: "CASE no encontrado" });

  return res.send({ ok: true, case_id, wa_id: found.wa_id, state: found.state });
});

// ===== Endpoint para Telegram bot: marcar boleta enviada =====
// POST /case/boleta-enviada  { "case_id": "CASE-...", "message": "opcional" }
app.post("/case/boleta-enviada", async (req, res) => {
  const block = requireAdmin(req, res);
  if (block) return;

  const { case_id, message } = req.body || {};
  if (!case_id) return res.status(400).send({ ok: false, error: "Falta case_id" });

  const found = await findCaseRowByCaseId(case_id);
  if (!found) return res.status(404).send({ ok: false, error: "CASE no encontrado" });

  // Recomendado: solo permitir si ya está APROBADO
  if (found.state !== "APROBADO") {
    return res.status(409).send({
      ok: false,
      error: `No se puede marcar BOLETA_ENVIADA si estado es ${found.state}`,
    });
  }

  await updateCaseStateByRowIndex(found.rowIndex0, "BOLETA_ENVIADA");

  // Mensaje al cliente opcional
  if (message) {
    await sendText(found.wa_id, message);
  } else {
    await sendText(found.wa_id, "✅ Tu boleta fue enviada. ¡Mucha suerte! 🍀");
  }

  return res.send({ ok: true, case_id, wa_id: found.wa_id, state: "BOLETA_ENVIADA" });
});

// ===== Meta verify =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Webhook receive =====
app.post("/webhook", async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const wa_id = msg.from;
    const type = msg.type;

    const state = await getLatestStateByWaId(wa_id);

    // ✅ Respuestas diferentes por estado (LO QUE PEDISTE)
    if (state === "EN_REVISION") {
      await sendText(wa_id, "🕒 Tu comprobante está en revisión. Te avisamos al aprobarlo.");
      return;
    }
    if (state === "APROBADO") {
      await sendText(wa_id, "✅ ¡Pago aprobado! En breve te enviamos tu boleta por este WhatsApp. 🙌");
      return;
    }
    if (state === "BOLETA_ENVIADA") {
      await sendText(wa_id, "🎟️ Tu boleta ya fue enviada. Si no la ves, dime y te ayudamos.");
      return;
    }
    if (state === "RECHAZADO") {
      await sendText(wa_id, "⚠️ Tu pago fue rechazado. Por favor envíame de nuevo el comprobante o confirma los datos.");
      return;
    }

    // Imagen/Documento -> crear CASE
    if (type === "image" || type === "document") {
      const receipt_media_id =
        type === "image" ? msg.image?.id :
        type === "document" ? msg.document?.id :
        "";

      const { case_id } = await createCase({
        wa_id,
        last_msg_type: type,
        receipt_media_id,
        receipt_is_payment: "UNKNOWN",
      });

      clearConvo(wa_id);
      await sendText(wa_id, `✅ Comprobante recibido. Caso ${case_id}. En revisión.`);
      return;
    }

    // Texto -> reglas + memoria + IA
    if (type === "text") {
      const text = msg.text?.body || "";

      if (isAlreadyPaidIntent(text)) {
        setConvo(wa_id, { stage: "WAIT_RECEIPT_AND_DATA" });
        await sendText(wa_id, paidInstructionMessage());
        return;
      }

      const c = getConvo(wa_id);

      if (c?.stage === "WAIT_QTY") {
        const qty = tryExtractBoletasQty(text);
        if (!qty) return sendText(wa_id, "¿Cuántas boletas deseas? (Ej: 1, 2, 5, 7, 10)");
        const breakdown = calcTotalCOPForBoletas(qty);
        if (!breakdown) return sendText(wa_id, "¿Cuántas boletas deseas? (Ej: 1, 2, 5, 10)");
        setConvo(wa_id, { stage: "WAIT_PAY_METHOD", qty });
        await sendText(wa_id, pricingReplyMessage(qty, breakdown));
        return;
      }

      if (c?.stage === "WAIT_PAY_METHOD") {
        const pm = isPayMethod(text);
        if (!pm) return sendText(wa_id, "¿Prefieres pagar por *Nequi* o *Daviplata*?");
        setConvo(wa_id, { stage: "WAIT_RECEIPT_AND_DATA", payMethod: pm });
        await sendText(
          wa_id,
          `✅ Puedes pagar por *${pm === "NEQUI" ? "Nequi" : "Daviplata"}* al número *3223146142*.\n` +
          "Luego envíame el *comprobante* (foto o PDF) y tus datos:\n- Nombre\n- Teléfono\n- Municipio\n- Cantidad de boletas"
        );
        return;
      }

      if (c?.stage === "WAIT_RECEIPT_AND_DATA") {
        await sendText(wa_id, paidInstructionMessage());
        return;
      }

      if (isPricingIntent(text)) {
        const qty = tryExtractBoletasQty(text);
        if (!qty) {
          setConvo(wa_id, { stage: "WAIT_QTY" });
          await sendText(wa_id, "✅ Claro. ¿Cuántas boletas deseas? (Ej: 1, 2, 5, 7, 10)");
          return;
        }
        const breakdown = calcTotalCOPForBoletas(qty);
        if (!breakdown) {
          setConvo(wa_id, { stage: "WAIT_QTY" });
          await sendText(wa_id, "¿Cuántas boletas deseas? (Ej: 1, 2, 5, 10)");
          return;
        }
        setConvo(wa_id, { stage: "WAIT_PAY_METHOD", qty });
        await sendText(wa_id, pricingReplyMessage(qty, breakdown));
        return;
      }

      if (looksLikeBuyIntent(text)) {
        setConvo(wa_id, { stage: "WAIT_QTY" });
        await sendText(wa_id, "✅ ¡Listo! ¿Cuántas boletas deseas comprar? (Ej: 1, 2, 5, 7, 10)");
        return;
      }

      const aiReply = await askOpenAI(text);
      await sendText(wa_id, aiReply);
      return;
    }
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));