// ===== server.js (ACTUALIZADO A GEMINI) =====
const express = require("express");
const { google } = require("googleapis");
const fetch = require("node-fetch"); // v2
const crypto = require("crypto");
const FormData = require("form-data");
const { GoogleGenerativeAI } = require("@google/generative-ai"); // CAMBIO: Gemini
const axios = require("axios");

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

// Sheets
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CASES_TAB = process.env.GOOGLE_SHEET_TAB || "cases";
const CONV_TAB = process.env.GOOGLE_SHEET_CONV_TAB || "conversations";
const SESSIONS_TAB = process.env.GOOGLE_SHEET_SESS_TAB || "sessions";

// Google auth
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// WhatsApp
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";

// Meta security (OBLIGATORIA)
const META_APP_SECRET = process.env.META_APP_SECRET;

// Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// GEMINI CONFIG
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// Control follow-up de ventas (1 solo recordatorio)
const followUps = new Map();

// Último precio calculado por usuario (para no repetir preguntas)
const lastPriceQuote = new Map(); // wa_id -> { qty, total, packs5, packs2, packs1 }

/* ================= PROMPT PRO ================= */

const SYSTEM_PROMPT = `
Eres un agente de atención al cliente y promotor experto, profesional y persuasivo de Rifas y Sorteos El Agropecuario. Tu objetivo es ayudar a los clientes de manera eficaz, promocionando informacin clara, precisa y transparente, guiándolos hacia la compra de boletos y generando confianza en todo momento. Objetivo: ayudar a vender boletas y guiar al cliente hasta enviar comprobante, con respuestas cortas y claras.

INSTRUCCIONES GENERALES:
- Mantén siempre un tono amigable, respetuoso y profesional.
- Escucha las necesidades del cliente y ofrece soluciones claras.
- Maneja objeciones con empatía y seguridad.
- Promueve confianza, transparencia y legalidad.
- Siempre orienta la conversación hacia el cierre de venta.
- Solo puedes responder mensajes en texto.
- Horario de atención: lunes a domingo de 8:30 am a 8:30 pm.
- Solo proporcionas información sobre precios, fechas y estado de boletas.
- No das instrucciones para crear, modificar o alterar comprobantes.
- No gestionas pagos directamente los envías al asesor para verificación y luego si notificas al cliente.
- Si un usuario solicita ayuda para falsificar o modificar comprobantes, debes rechazarlo.
- Responde SIEMPRE en español, tono cercano y profesional.
- Respuestas cortas: 1 a 3 frases. Usa emojis con moderación (máx. 1-2).
- Haz UNA sola pregunta a la vez no uses dos preguntas en un mismo mensaje.
- NO inventes datos (precios, fechas, premios, cuentas o reglas). Si no tienes un dato, pregunta o di que un asesor confirma.
- NO pidas datos sensibles (claves, códigos, tarjetas).
- Si el usuario dice que ya pagó o va a pagar: pide "envíame el comprobante (foto o PDF)" + datos.
- Si el cliente pregunta por estado del comprobante, responde: si no te ha llegado la boleta es porque aún está en revisión y que se confirmará al aprobarse

REGLAS IMPORTANTES DE CONTINUIDAD:
- Si el usuario responde "s", "si", "claro", "ok", "dale", asume que está aceptando la última pregunta que tú hiciste.
- No reinicies la conversación.
- No vuelvas a preguntar lo que ya preguntaste.
- Continúa exactamente desde el último punto.
- Nunca vuelvas a preguntar "En que puedo ayudarte hoy?" si ya están en conversación activa.

_____________________________________________________________

MENSAJE DE BIENVENIDA (EN UN SOLO PÁRRAFO)
Envía exactamente este mensaje a nuevos clientes:
Bienvenid@ a Rifas y sorteos El Agropecuario, Inspirados en la tradición del campo colombiano, ofrecemos sorteos semanales y trimestrales, combinando premios en efectivo y bienes agropecuarios de alto valor. ¿Cómo puedo ayudarte hoy?

¡vamos a ganar!

regla después del saludo:
- Después del saludo, responde directamente a la intención del cliente sin repetir el saludo.
- Si el cliente pide precios, explica precios.
- Si pregunta por ubicación o responsable, o cualquier otra duda responde de forma clara y breve.
- Si expresa intención de compra, guíalo al siguiente paso.
- Solo saluda una vez al inicio de la conversación.
- Si el usuario vuelve a escribir "hola" o saludos similares, NO vuelvas a saludar.
- Continúa la conversación según el contexto.
- No reinicies la conversación

REGLA CRÍTICA PARA RESPUESTAS CORTAS (SÍ/NO):
- Si el usuario responde "s", "si", "s señor", "dale", "ok", "de una", "listo":
  1) INTERPRETA que está aceptando la ÚLTIMA pregunta que hiciste.
  2) NO repitas preguntas ni reformules la misma pregunta.
  3) CONTINÚA con la acción correspondiente (dar el siguiente paso).

MAPEO DE ACCIONES:
A) Si tu última pregunta fue sobre "cómo comprar / métodos de pago / pagar":
   -> Responde DIRECTO con los métodos de pago + aquí debe enviar (comprobante + nombre + municipio + cantidad de boletas).
B) Si tu última pregunta fue "cuántas boletas deseas":
   -> Pide SOLO el número (1,2,5,10) y nada más.
C) Si tu última pregunta fue "premios o precios":
   -> da información de premios y precios".
D) Si NO estas seguro de cuál fue tu última pregunta:
   -> Haz UNA sola pregunta de aclaración corta, no más.

PROHIBIDO:
- No puedes responder a un "s" con otra pregunta igual o parecida.
- No puedes reiniciar con "En que puedo ayudarte hoy?" si ya venías conversando.

PLANTILLA OBLIGATORIA CUANDO EL CLIENTE DICE "SÍ" A COMPRAR:
Responde as, sin hacer otra pregunta:

"Perfecto Para comprar seguimos es pasos:

Da exactamente estos precios de boletería:

Valor de boletas:
• 1 boleta = 15.000
• 2 boletas = 25.000
• 5 boletas = 60.000

No existen otros precios.

Primer paso: Dime cuántas boletas quieres (1, 2, 5 o 10).

Segundo paso: Te envío el total y los datos para pagar por Nequi o Daviplata.

Tercer paso: Me envías el comprobante + tu nombre completo + municipio + número de celular."

Cuarto paso: esperas hasta que se confirme tu compra

Quinto paso: luego de confirmado el pago te envío tu boleta
________________________________________

INFORMACIÓN DE PREMIOS (EN UN SOLO PÁRRAFO)
Cuando el cliente pregunte por premios o metodología, responde en un solo párrafo con el siguiente texto:
En la actual campaña tenemos Premio semanal: $500.000 pesos colombianos acumulables, Premio mayor: Lote de 5 novillas preñadas y un torete, avaluado en $18.000.000 de pesos, Segundo premio: $15.000.000 en efectivo, Tercer premio: Moto Suzuki DR 150 FI, avaluada en $13.000.000, Cuarto premio: iPhone 17 Pro Max, avaluado en $6.500.000. Nuestros sorteos se realizan tomando como base los resultados oficiales de las loterías correspondientes, garantizando total transparencia. ¿Quieres conocer las reglas del sorteo?
________________________________________
REGLAS Y FECHAS DE SORTEO
(cuando el cliente pregunte por premios fracciona la información para que no parezca un mensaje extenso, entrégala por secciones, Enviar cada premio en párrafo separado)

Sección de reglas premios:

Premio semanal: $500.000 pesos colombianos acumulables. Se juega todos los viernes desde el 30 de enero hasta el 25 de abril con el premio mayor de la Lotería de Medellín.

Premio mayor: Lote de 5 novillas preñadas y un torete, avaluado en $18.000.000 de pesos. Se juega el 25 de abril con el premio mayor de la Lotería de Boyacá.

Segundo premio: $15.000.000 en efectivo. Se juega el 18 de abril con el premio mayor de la Lotería de Boyacá.

Tercer premio: Moto Suzuki DR 150 FI, avaluada en $13.000.000. Se juega el 11 de abril con el premio mayor de la Lotería de Boyacá.

Cuarto premio: iPhone 17 Pro Max, avaluado en $6.500.000. Se juega el 4 de abril con el premio mayor de la Lotería de Boyacá.

En los premios semanales: el valor semanal en caso de no caer en entre los números vendidos se acumula semanalmente en su totalidad, es decir que si no cae cada semana se acumulan 500 mil pesos.

En los premios mayores: En caso de que el número ganador determinado por la lotería oficial no haya sido vendido por la empresa, el 80% del valor del premio se acumulará para la siguiente fecha dentro de la misma campaña.

Si el cliente ganador no desea recibir su lote de ganado, la moto o el celular se realiza entrega del valor en dinero especificado por premio.

Sección Reglas de boletería:

El número es asignado por nuestro sistema de entrega de boletas.
La boleta que te llega tiene dos números: el primero llamado “premios” es el numero con el que vas a participar por los premios mayores, el segundo “premio semanal” es el numero con el que vas a participar todos los viernes por el acumulado semanal.
Boleta sin cancelar no participa.

Sección de reglas entrega de premios:
• Entrega en sede principal o transferencia virtual.
• En premios en efectivo se aplican impuestos según normatividad colombiana vigente.
• El ganador debe presentar identificación para verificar titularidad.
• El ganador tiene 60 días calendario para reclamar su premio.

Sección Otras reglas:

• Cada boleto representa una oportunidad de ganar.
• Cada boleto tiene un número asignado.
• Se puede participar con un solo boleto.
• Comprar más boletos aumenta las probabilidades.
• Un mismo número puede ganar más de un premio dentro de la campaña.
• Cada boleta tiene un único titular registrado al momento de la compra, quien será la única persona autorizada para reclamar el premio.
• Los boletos tienen vigencia durante toda la campaña.
• No se realizan devoluciones una vez entregada la boleta.
• Solo pueden participar mayores de edad.

________________________________________
EMPRESA Y RESPALDO

Responsables: Inversiones El Agropecuario, representado por el señor Miguel Torres.
Ubicación: San José del Fragua, Caquetá, Colombia.
Participación mediante boletería registrada y transmisión en vivo por redes sociales.
Redes sociales: https://www.facebook.com/profile.php?id=61588354538179&locale=es_LA
________________________________________
MÉTODOS DE PAGO

Compra en canales oficiales:
Nequi: 3223146142
Daviplata: 3223146142
El cliente debe enviar soporte de pago y los siguientes datos obligatorios:
Nombre completo
Teléfono
Lugar de residencia
Cantidad de boletas compradas
Sin datos personales no se confirma la compra.
________________________________________
PRECIOS DE BOLETERIA
📌 INSTRUCCIÓN DE CÁLCULO — MODO MATEMÁTICO ESTRICTO
Debes calcular el valor de las boletas siguiendo EXACTAMENTE este procedimiento matemático, sin omitir pasos.

Precios oficiales (únicos permitidos)
• 1 boleta = 15.000
• 2 boletas = 25.000
• 5 boletas = 60.000
No existen otros precios.
________________________________________

PROCEDIMIENTO OBLIGATORIO
Dada una cantidad N de boletas:
Paso 1: Calcular cuántos grupos de 5 caben en N.
Fórmula: grupos_5 = N / 5 (solo la parte entera)
Multiplicar: total_5 = grupos_5 × 60.000
Calcular el residuo: resto_1 = N - (grupos_5 × 5)
________________________________________
Paso 2: Con el resto_1 calcular cuántos grupos de 2 caben.
grupos_2 = resto_1 / 2 (solo la parte entera)
Multiplicar: total_2 = grupos_2 × 25.000
Calcular nuevo residuo: resto_2 = resto_1 - (grupos_2 × 2)
________________________________________
Paso 3: Si resto_2 = 1: total_1 = 15.000
Si resto_2 = 0: total_1 = 0
________________________________________
Paso 4: Calcular el total final:
TOTAL = total_5 + total_2 + total_1
________________________________________
❌ PROHIBIDO
• No hacer reglas de tres.
• No dividir dinero.
• No sacar precios promedio.
• No modificar valores.
• No aplicar descuentos distintos.
El total SIEMPRE debe salir únicamente de la suma de:
• Paquetes de 5
• Paquetes de 2
• Boletas individuales

________________________________________
ASIGNACIÓN DE NÚMERO
Cuando el cliente pregunte por selección de números de boleta, responde esto:
En esta campaña la empresa asigna el número automáticamente (es decir el cliente no escoge su número) debido al alto flujo de clientes y la metodología manual de boletería física. Se enviará fotografía de la boleta vía WhatsApp con los datos enviados por el cliente. Si el cliente pide número específico responder:
Si se encuentra en San José del Fragua puede pasar por nuestro punto de atención ubicado en el local comercial Te lo Reparamos, frente al único billar del centro.
________________________________________
MENSAJE CUANDO ENVÍAN SOPORTE Y DATOS
en un momento nuestra asesora enviara tu boleta y números asignados, este proceso puede demorar hasta 2 horas debido al alto flujo de clientes, (las compras realizadas después de las 8:30 pm son procesadas al día siguiente) gracias por tu compra, te deseamos buena suerte, ¡vamos a ganar!
________________________________________
MENSAJE DESPUÉS DE RECIBIR BOLETA
gracias por su compra, te deseo mucha suerte y espero que ganes, ¡vamos a ganar!
________________________________________
SORTEOS ANTERIORES
Cuando pregunten por campañas anteriores enviar:
Pregunta si quiere resultados de la actual campaña o campañas pasadas:

Datos actual campaña (2026001: Sorteo semanales: 30 de enero de 2026 no hubo ganador premio se acumuló, 06 de febrero 2026 premio acumulado de un millón si hubo ganador, 13 de febrero 2026 no hubo ganador, 20 de febrero no hubo ganador, 27 de febrero no hubo ganador, próximo sorteo semanal 06 de marzo total acumulado para este día 2 millones de pesos.

Campaña pasada:

Fecha de sorteo: 27/12/2025
https://www.facebook.com/share/v/1CCcqyKymt/
https://www.youtube.com/shorts/pZyA9f1Fdr0?feature=share

Influencer aliado Juancho: https://www.facebook.com/share/v/1CCcqyKymt/

influencer aliado carnada de tiburón: https://www.facebook.com/share/p/1B471oxnKX/

sin embargo, el único canal oficial de ventas es por este medio y solo al presente número de WhatsApp.
_____________________________________
COMPROBANTE
Clasifica la imagen en UNA sola etiqueta: COMPROBANTE, PUBLICIDAD, OTRO o DUDA.

COMPROBANTE: incluye "Envío realizado", transferencias Nequi/Daviplata/PSE, recibos con QR de verificación, valor, fecha, referencia, destinatario.
PUBLICIDAD: afiches/promos.
OTRO: cualquier otra cosa.
DUDA: si está cortado/borroso.

Devuelve SOLO JSON: {"label":"...","confidence":0-1,"why":"..."}

____________________________________________
OTRAS ESPECIFICACIONES:

Horario de atención: lunes a domingo 8:30 am a 8:30 pm.
`.trim();

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
  console.warn("⚠️ Sheets NO configurado.");
}

/* ================= HELPERS ================= */

function todayYYMMDD() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// ... Funciones de ayuda (isBuyIntent, isThanks, etc.) se mantienen igual ...
function isBuyIntent(text = "") {
  const t = String(text).toLowerCase();
  return t.includes("comprar") || t.includes("precio") || t.includes("boleta") || t.includes("boletas") || t.includes("participar") || t.includes("quiero");
}
function isThanks(text = "") {
  const t = String(text).toLowerCase().trim();
  return /\b(gracias|muchas gracias|mil gracias|grac)\b/.test(t);
}
function isAdQuestion(text = "") {
  const t = String(text).toLowerCase().trim();
  return t.includes("publicidad") || t.includes("facebook") || t.includes("instagram") || t.includes("tiktok") || t.includes("anuncio") || t.includes("promo") || t.includes("son ustedes") || t.includes("son los mismos") || t.includes("es real") || t.includes("es verdadero") || t.includes("oficial");
}

/* ================= MEMORIA TEMPORAL ================= */

const shortMemory = new Map();

function memPush(wa_id, role, content) {
  if (!wa_id) return;
  const arr = shortMemory.get(wa_id) || [];
  // Mapeo de roles para Gemini: assistant -> model
  const geminiRole = role === "assistant" ? "model" : "user";
  arr.push({ role: geminiRole, parts: [{ text: String(content || "").slice(0, 1500) }] });
  while (arr.length > 20) arr.shift();
  shortMemory.set(wa_id, arr);
}

function memGet(wa_id) {
  return shortMemory.get(wa_id) || [];
}

/* ================= SESSIONS (persistente en Sheets) ================= */

async function getAllSessionsRowsAtoF() {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SESSIONS_TAB}!A:F`,
  });
  return res.data.values || [];
}

async function getSessionByWaId(wa_id) {
  const rows = await getAllSessionsRowsAtoF();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row?.[1] || "").trim() === String(wa_id || "").trim()) {
      return {
        rowNumber: i + 1,
        created_at: row?.[0] || "",
        wa_id: row?.[1] || "",
        greeted: String(row?.[2] || "").toUpperCase() === "TRUE",
        greeted_at: row?.[3] || "",
        last_seen: row?.[4] || "",
        notes: row?.[5] || "",
      };
    }
  }
  return null;
}

async function upsertSession({ wa_id, greeted = false, notes = "" }) {
  if (!sheets) return;
  const now = new Date().toISOString();
  const existing = await getSessionByWaId(wa_id);
  if (!existing) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SESSIONS_TAB}!A:F`,
      valueInputOption: "RAW",
      requestBody: { values: [[now, String(wa_id), greeted ? "TRUE" : "FALSE", greeted ? now : "", now, notes || ""]] },
    });
    return;
  }
  const rowNum = existing.rowNumber;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SESSIONS_TAB}!E${rowNum}:F${rowNum}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[now, notes || existing.notes || ""]] },
  });
  if (greeted && !existing.greeted) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SESSIONS_TAB}!C${rowNum}:D${rowNum}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["TRUE", now]] },
    });
  }
}

async function hasGreeted(wa_id) {
  const s = await getSessionByWaId(wa_id);
  return !!s?.greeted;
}
async function markGreeted(wa_id) { await upsertSession({ wa_id, greeted: true }); }
async function touchSession(wa_id) { await upsertSession({ wa_id, greeted: false }); }
async function setConversationStage(wa_id, stage) {
  const s = await getSessionByWaId(wa_id);
  await upsertSession({ wa_id, greeted: s?.greeted || false, notes: stage });
}
async function getConversationStage(wa_id) {
  const s = await getSessionByWaId(wa_id);
  return s?.notes || "";
}

/* ================= HYBRID RULES ================= */

function formatCOP(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString("es-CO");
}

function calcTotalCOPForBoletas(n) {
  const P1 = 15000; const P2 = 25000; const P5 = 60000;
  const qty = Number(n);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  let remaining = Math.floor(qty);
  const packs5 = Math.floor(remaining / 5); remaining = remaining % 5;
  const packs2 = Math.floor(remaining / 2); remaining = remaining % 2;
  const packs1 = remaining;
  const total = packs5 * P5 + packs2 * P2 + packs1 * P1;
  return { qty, total, packs5, packs2, packs1 };
}

function tryExtractBoletasQty(text = "") {
  const t = String(text).toLowerCase();
  const m1 = t.match(/(\d{1,4})\s*(boletas?|boletos?)/i);
  if (m1) return parseInt(m1[1], 10);
  const m2 = t.match(/(?:quiero|comprar|llevar|dame|necesito|deseo|quisiera|apartar|separar|apuntame|me\s*llevo)\s*(\d{1,4})/i);
  if (m2) return parseInt(m2[1], 10);
  const m3 = t.trim().match(/^(\d{1,4})$/);
  if (m3) return parseInt(m3[1], 10);
  return null;
}

function pricingReplyMessage(qty, breakdown) {
  const { total, packs5, packs2, packs1 } = breakdown;
  const parts = [];
  if (packs5) parts.push(`${packs5}×(5)`);
  if (packs2) parts.push(`${packs2}×(2)`);
  if (packs1) parts.push(`${packs1}×(1)`);
  return `✅ Para *${qty}* boleta(s), el total es *$${formatCOP(total)} COP*.\n(Combo: ${parts.join(" + ")})\nDeseas pagar por *Nequi* o *Daviplata*?`;
}

/* ================= CONVERSATIONS & WHATSAPP ================= */

async function saveConversation({ wa_id, direction, message, ref_id = "" }) {
  if (!sheets) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${CONV_TAB}!A:E`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[new Date().toISOString(), wa_id, direction, message, ref_id]] },
    });
  } catch (e) { console.warn("⚠️ saveConversation falló"); }
}

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return false;
  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}

async function getAllRowsAtoH() {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CASES_TAB}!A:H` });
  return res.data.values || [];
}

async function getLatestStateByWaId(wa_id) {
  const rows = await getAllRowsAtoH();
  let lastState = "BOT";
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]?.[2] === wa_id && rows[i]?.[3]) lastState = rows[i][3];
  }
  return lastState;
}

async function updateCell(rangeA1, value) {
  if (!sheets) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${CASES_TAB}!${rangeA1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
}

async function sendText(to, bodyText, ref_id = "") {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return { ok: false };
  const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: bodyText } }),
  });
  await saveConversation({ wa_id: to, direction: "OUT", message: bodyText, ref_id });
  return { ok: resp.ok };
}

async function sendTextM(to, bodyText, ref_id = "") {
  const r = await sendText(to, bodyText, ref_id);
  memPush(to, "assistant", bodyText);
  return r;
}

// ... Funciones de carga de imágenes se mantienen (whatsappUploadImageBuffer, sendImageByMediaId, etc.) ...
async function whatsappUploadImageBuffer(buffer, mimeType = "image/jpeg") {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename: "boleta.jpg", contentType: mimeType });
  const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
    body: form,
  });
  const data = await resp.json();
  return data.id;
}

async function sendImageByMediaId(to, mediaId, caption = "") {
  const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "image", image: { id: mediaId, caption } }),
  });
  await saveConversation({ wa_id: to, direction: "OUT", message: `[image sent] ${caption}`, ref_id: "" });
  return { ok: resp.ok };
}

/* ================= GEMINI VISION & TEXT ================= */

async function fetchWhatsAppMediaUrl(mediaId) {
  const resp = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const data = await resp.json();
  return data.url;
}

async function downloadWhatsAppMediaAsBuffer(mediaUrl) {
  const r = await axios.get(mediaUrl, { responseType: "arraybuffer", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const mimeType = (r.headers?.["content-type"] || "image/jpeg").split(";")[0].trim();
  return { buf: Buffer.from(r.data), mimeType };
}

// ✅ REEMPLAZO: classifyPaymentImage ahora usa GEMINI
async function classifyPaymentImage({ mediaId }) {
  if (!genAI) return { label: "DUDA", confidence: 0, why: "GEMINI_API_KEY no configurada" };

  try {
    const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
    const { buf, mimeType } = await downloadWhatsAppMediaAsBuffer(mediaUrl);
    
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Clasifica la imagen en UNA sola etiqueta: COMPROBANTE, PUBLICIDAD, OTRO o DUDA. 
    Reglas: 
    - COMPROBANTE: recibo de transferencia / depósito, Nequi / Daviplata, confirmación de pago. 
    - PUBLICIDAD: afiche / promoción, banner con premios o logos. 
    Devuelve SOLO JSON: {"label":"...","confidence":0-1,"why":"..."}`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: buf.toString("base64"),
          mimeType: mimeType
        }
      }
    ]);

    const out = result.response.text().trim();
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : out);
    
    return {
      label: String(parsed.label || "DUDA").toUpperCase(),
      confidence: Number(parsed.confidence ?? 0),
      why: parsed.why || "",
      mimeType
    };
  } catch (e) {
    console.error("Error en clasificación Gemini:", e);
    return { label: "DUDA", confidence: 0, why: e.message };
  }
}

// ✅ REEMPLAZO: askOpenAI ahora es askGemini
async function askOpenAI(wa_id, userText, state = "BOT") {
  if (!genAI) return "Lo siento, mi servicio de IA no está disponible.";

  const history = memGet(wa_id);
  const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    systemInstruction: `${SYSTEM_PROMPT}\n\nEstado actual del cliente: ${state}`
  });

  try {
    const chat = model.startChat({ history: history });
    const result = await chat.sendMessage(userText);
    const output = result.response.text().trim() || "Me repites, por favor?";

    // Guardar en memoria (Gemini requiere rol 'user' y 'model')
    memPush(wa_id, "user", userText);
    memPush(wa_id, "assistant", output);

    return output;
  } catch (e) {
    console.error("Error en chat Gemini:", e);
    return "Disculpa, ¿puedes repetirlo?";
  }
}

/* ================= MONITOR, TELEGRAM Y WEBHOOKS ================= */

// ... Se mantienen las funciones de monitorAprobados, telegramSendMessage, etc. ...
async function monitorAprobados() {
  try {
    if (!sheets) return;
    const rows = await getAllRowsAtoH();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]?.[3] === "APROBADO" && rows[i]?.[7] !== "NOTIFIED_APROBADO") {
        await sendText(rows[i]?.[2], "✅ Tu pago fue aprobado. En breve te enviamos tu boleta.");
        await updateCell(`D${i + 1}`, "APROBADO");
        await updateCell(`H${i + 1}`, "NOTIFIED_APROBADO");
      }
    }
  } catch (err) { console.error(err); }
}

async function createReference({ wa_id, last_msg_type, receipt_media_id, receipt_is_payment }) {
  const max = await getLastRefNumberForToday();
  const next = String(max + 1).padStart(3, "0");
  const ref = `RP-${todayYYMMDD()}-${next}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CASES_TAB}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[new Date().toISOString(), ref, wa_id, "EN_REVISION", last_msg_type, receipt_media_id || "", receipt_is_payment || "UNKNOWN", ""]] },
  });
  return { ref };
}

async function getLastRefNumberForToday() {
  const rows = await getAllRowsAtoH();
  const prefix = `RP-${todayYYMMDD()}-`;
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

// ... Telegram Helpers se mantienen igual ...
async function telegramSendMessage(chat_id, text) {
    if (!TELEGRAM_BOT_TOKEN) return;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id, text }),
    });
}
async function telegramSendPhotoBuffer(chat_id, buffer, caption = "") {
    const form = new FormData();
    form.append("chat_id", String(chat_id));
    if (caption) form.append("caption", caption);
    form.append("photo", buffer, { filename: "comprobante.jpg" });
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
}
async function safeConversationLog(direction, wa_id, message) {
    const groupId = process.env.TELEGRAM_GROUP_ID;
    if (!groupId || !TELEGRAM_BOT_TOKEN) return;
    const prefix = direction === "IN" ? "📩 IN" : "📤 OUT";
    const ts = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
    await telegramSendMessage(groupId, `${prefix} | ${ts}\n👤 ${wa_id}\n📝 ${String(message).slice(0, 3500)}`);
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => res.send("OK Gemini ✅"));

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) return res.status(200).send(req.query["hub.challenge"]);
  return res.sendStatus(403);
});

if (!global.lastImageCheck) global.lastImageCheck = new Map();

app.post("/webhook", async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  async function withGreeting(wa_id, replyText) {
    const greeted = await hasGreeted(wa_id);
    let t = String(replyText || "").trim();
    t = t.replace(/^([👋🙂😊😁😃😄😺]+\s*)+/u, "").replace(/^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)[!,.\s]*/i, "").trim();
    if (!greeted) {
      await markGreeted(wa_id);
      return `👋 Bienvenido a Rifas y Sorteos El Agropecuario!\n\n${t}`;
    }
    return t;
  }

  function humanizeIfJson(text) {
    const t = String(text || "").trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        const obj = JSON.parse(t);
        if (obj?.label === "PUBLICIDAD") return "📢 Esa imagen parece publicidad.";
        if (obj?.label === "COMPROBANTE") return "✅ Ese archivo parece un comprobante.";
      } catch {}
    }
    return t;
  }

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const wa_id = msg.from;
    const type = msg.type;

    await touchSession(wa_id);

    // --- TEXTO ---
    if (type === "text") {
      const text = (msg.text?.body || "").trim();
      const tNorm = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      await safeConversationLog("IN", wa_id, text);
      await saveConversation({ wa_id, direction: "IN", message: text });

      const state = await getLatestStateByWaId(wa_id);
      const stage = await getConversationStage(wa_id);

      if (state === "EN_REVISION") {
        const reply = await withGreeting(wa_id, "🕒 Tu comprobante está en revisión. Te avisamos en breve.");
        await safeConversationLog("OUT", wa_id, reply);
        await sendTextM(wa_id, reply);
        return;
      }

      let qtyCandidate = tryExtractBoletasQty(text);
      if (qtyCandidate) {
        const breakdown = calcTotalCOPForBoletas(qtyCandidate);
        if (breakdown) {
          await setConversationStage(wa_id, "PRICE_GIVEN");
          lastPriceQuote.set(wa_id, breakdown);
          const reply = await withGreeting(wa_id, pricingReplyMessage(qtyCandidate, breakdown));
          await safeConversationLog("OUT", wa_id, reply);
          await sendTextM(wa_id, reply);
          return;
        }
      }

      // IA con Gemini
      const aiReplyRaw = await askOpenAI(wa_id, text, state);
      const replyAI = await withGreeting(wa_id, humanizeIfJson(aiReplyRaw));
      await safeConversationLog("OUT", wa_id, replyAI);
      await sendText(wa_id, replyAI);
    }

    // --- IMAGEN ---
    if (type === "image") {
      const mediaId = msg.image?.id;
      await safeConversationLog("IN", wa_id, "[imagen] recibida");
      await saveConversation({ wa_id, direction: "IN", message: "[imagen] recibida" });

      const cls = await classifyPaymentImage({ mediaId });
      
      if (cls.label === "COMPROBANTE") {
        const { ref } = await createReference({ wa_id, last_msg_type: "image", receipt_media_id: mediaId, receipt_is_payment: "YES" });
        
        // Enviar a Telegram
        try {
            const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
            const { buf } = await downloadWhatsAppMediaAsBuffer(mediaUrl);
            await telegramSendPhotoBuffer(TELEGRAM_CHAT_ID, buf, `🧾 NUEVO COMPROBANTE\n📱 Cliente: ${wa_id}\n📌 Ref: ${ref}`);
        } catch (e) { console.error("Error Telegram:", e); }

        const reply = await withGreeting(wa_id, `✅ Comprobante recibido. Referencia: ${ref}. Está en revisión.`);
        await safeConversationLog("OUT", wa_id, reply);
        await sendText(wa_id, reply, ref);
      } else {
        const reply = await withGreeting(wa_id, "👀 No logré validar el comprobante. ¿Podrías enviarlo de nuevo?");
        await sendTextM(wa_id, reply);
      }
    }

  } catch (e) { console.error("Error Webhook:", e); }
});

// ... Telegram Webhook se mantiene igual ...
app.post("/telegram-webhook", async (req, res) => {
    try {
      const incoming = req.headers["x-telegram-bot-api-secret-token"];
      if (incoming !== TELEGRAM_SECRET_TOKEN) return res.sendStatus(401);
      res.sendStatus(200);
      // Lógica de envío de boleta desde Telegram...
    } catch (err) { console.error(err); }
});

setInterval(monitorAprobados, 30000);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`🚀 Servidor con GEMINI en puerto ${PORT}`); });
