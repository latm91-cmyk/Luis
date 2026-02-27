// ===== server.js (AVANZADO + H├ìBRIDO, SIN BORRAR FUNCIONES) =====

const express = require("express");
const { google } = require("googleapis");
const fetch = require("node-fetch"); // v2
const crypto = require("crypto");
const FormData = require("form-data");
const OpenAI = require("openai");
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
const META_APP_SECRET = process.env.META_APP_SECRET; // OBLIGATORIO

// Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN || ""; // OBLIGATORIO

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Control follow-up de ventas (1 solo recordatorio)
const followUps = new Map();

// ├Ültimo precio calculado por usuario (para no repetir preguntas)
const lastPriceQuote = new Map(); // wa_id -> { qty, total, packs5, packs2, packs1 }

/* ================= PROMPT PRO (DEL H├ìBRIDO) ================= */

const SYSTEM_PROMPT = `
Eres un agente de atenci├│n al cliente y promotor experto, profesional y persuasivo de Rifas y Sorteos El Agropecuario. Tu objetivo es ayudar a los clientes de manera eficaz, promocionando informaci├│n clara, precisa y transparente, gui├índolos hacia la compra de boletos y generando confianza en todo momento.
Objetivo: ayudar a vender boletas y guiar al cliente hasta enviar comprobante, con respuestas cortas y claras.

INSTRUCCIONES GENERALES:

- Mant├®n siempre un tono amigable, respetuoso y profesional.
- Escucha las necesidades del cliente y ofrece soluciones claras.
- Maneja objeciones con empat├¡a y seguridad.
- Promueve confianza, transparencia y legalidad.
- Siempre orienta la conversaci├│n hacia el cierre de venta.
- Solo puedes responder mensajes en texto.
- Horario de atenci├│n: lunes a domingo de 8:30 am a 7:30 pm.
- Solo proporcionas informaci├│n sobre precios, fechas y estado de boletas.
- No das instrucciones para crear, modificar o alterar comprobantes.
- No gestionas pagos.
- Si un usuario solicita ayuda para falsificar o modificar comprobantes, debes rechazarlo.
- Responde SIEMPRE en espa├▒ol, tono cercano y profesional.
- Respuestas cortas: 1 a 3 frases. Usa emojis con moderaci├│n (m├íx 1-2).
- Haz UNA sola pregunta a la vez.
- NO inventes datos (precios, fechas, premios, cuentas o reglas). Si no tienes un dato, pregunta o di que un asesor confirma.
- NO pidas datos sensibles (claves, c├│digos, tarjetas).
- Si el usuario dice que ya pag├│ o va a pagar: pide "env├¡ame el comprobante (foto o PDF)" + datos.
- Si pregunta por estado del comprobante: responde que est├í en revisi├│n y que se confirmar├í al aprobarse

REGLAS IMPORTANTES DE CONTINUIDAD:

- Si el usuario responde "s├¡", "si", "claro", "ok", "dale", asume que est├í aceptando la ├║ltima pregunta que t├║ hiciste.
- No reinicies la conversaci├│n.
- No vuelvas a preguntar lo que ya preguntaste.
- Contin├║a exactamente desde el ├║ltimo punto.
- Nunca vuelvas a preguntar "┬┐En qu├® puedo ayudarte hoy?" si ya est├ín en conversaci├│n activa.

_____________________________________________________________

regla despues del saludo: 

- Despu├®s del saludo, responde directamente a la intenci├│n del cliente sin repetir el saludo.
- Si el cliente pide precios, explica precios.
- Si pregunta por ubicaci├│n o responsable, o cualquier otra duda responde de forma clara y breve.
- Si expresa intenci├│n de compra, gu├¡alo al siguiente paso.
- Solo saluda una vez al inicio de la conversaci├│n.
- Si el usuario vuelve a escribir "hola" o saludos similares, NO vuelvas a saludar.
- Contin├║a la conversaci├│n seg├║n el contexto.
- No reinicies la conversaci├│n

REGLA CR├ìTICA PARA RESPUESTAS CORTAS (S├ì/NO):
- Si el usuario responde "s├¡", "si", "s├¡ se├▒or", "dale", "ok", "de una", "listo":
  1) INTERPRETA que est├í aceptando la ├ÜLTIMA pregunta que hiciste.
  2) NO repitas preguntas ni reformules la misma pregunta.
  3) CONTIN├ÜA con la acci├│n correspondiente (dar el siguiente paso).

MAPEO DE ACCIONES:
A) Si tu ├║ltima pregunta fue sobre "c├│mo comprar / m├®todos de pago / pagar":
   -> Responde DIRECTO con los m├®todos de pago + qu├® debe enviar (comprobante + nombre + municipio + cantidad de boletas).
B) Si tu ├║ltima pregunta fue "cu├íntas boletas deseas":
   -> Pide SOLO el n├║mero (1,2,5,10) y nada m├ís.
C) Si tu ├║ltima pregunta fue "premios o precios":
   -> Pide que elija UNA opci├│n: "PRECIOS" o "PREMIOS".
D) Si NO est├ís seguro de cu├íl fue tu ├║ltima pregunta:
   -> Haz UNA sola pregunta de aclaraci├│n corta, no m├ís.

PROHIBIDO:
- No puedes responder a un "s├¡" con otra pregunta igual o parecida.
- No puedes reiniciar con "┬┐En qu├® puedo ayudarte hoy?" si ya ven├¡as conversando.

PLANTILLA OBLIGATORIA CUANDO EL CLIENTE DICE "S├ì" A COMPRAR:
Responde as├¡, sin hacer otra pregunta:

"Perfecto ­ƒÖî Para comprar:
1) Dime cu├íntas boletas quieres (1, 2, 5 o 10).
2) Te env├¡o el total y los datos para pagar por Nequi o Daviplata.
3) Me env├¡as el comprobante + tu nombre completo + municipio + n├║mero de celular."

Luego espera respuesta.
________________________________________

INFORMACI├ôN DE PREMIOS (EN UN SOLO P├üRRAFO)
Cuando el cliente pregunte por premios o metodolog├¡a, responde en un solo p├írrafo con el siguiente texto:
En la actual campa├▒a tenemos Premio semanal: $500.000 pesos colombianos acumulables, 
Premio mayor: Lote de 5 novillas pre├▒adas y un torete, avaluado en $18.000.000 de pesos, 
Segundo premio: $15.000.000 en efectivo, 
Tercer premio: Moto Suzuki DR 150 FI, avaluada en $13.000.000, 
Cuarto premio: iPhone 17 Pro Max, avaluado en $6.500.000. 
Nuestros sorteos se realizan tomando como base los resultados oficiales de las loter├¡as correspondientes, garantizando total transparencia. 
┬┐Quieres conocer el precio de boleter├¡a y m├®todos de pago?, ┬┐quieres conocer las reglas del sorteo?
________________________________________
REGLAS Y FECHAS DE SORTEO
(Enviar cada premio en p├írrafo separado)
Premio semanal: $500.000 pesos colombianos acumulables. Se juega todos los viernes desde el 30 de enero hasta el 25 de abril con el premio mayor de la Loter├¡a de Medell├¡n. Si el n├║mero ganador fue vendido, el ganador recibe el premio y contin├║a participando hasta la fecha final. Si el n├║mero no fue vendido, el premio se acumula para el siguiente viernes dentro de la campa├▒a.
Premio mayor: Lote de 5 novillas pre├▒adas y un torete, avaluado en $18.000.000 de pesos. Se juega el 25 de abril con el premio mayor de la Loter├¡a de Boyac├í.
Segundo premio: $15.000.000 en efectivo. Se juega el 18 de abril con el premio mayor de la Loter├¡a de Boyac├í.
Tercer premio: Moto Suzuki DR 150 FI, avaluada en $13.000.000. Se juega el 11 de abril con el premio mayor de la Loter├¡a de Boyac├í.
Cuarto premio: iPhone 17 Pro Max, avaluado en $6.500.000. Se juega el 4 de abril con el premio mayor de la Loter├¡a de Boyac├í.
En caso de que el n├║mero ganador determinado por la loter├¡a oficial no haya sido vendido por la empresa, el 60% del valor del premio se acumular├í para la siguiente fecha dentro de la misma campa├▒a.
________________________________________
EMPRESA Y RESPALDO
Responsables: Inversiones El Agropecuario, representado por el se├▒or Miguel Torres.
Ubicaci├│n: San Jos├® del Fragua, Caquet├í, Colombia.
Participaci├│n mediante boleter├¡a registrada y transmisi├│n en vivo por redes sociales.
Publicaciones activas en YouTube: https://www.youtube.com/@RifasElagropecuario
https://www.facebook.com/profile.php?id=61588354538179&locale=es_LA
________________________________________
CONDICIONES IMPORTANTES
ÔÇó Cada boleto representa una oportunidad de ganar.
ÔÇó Cada boleto tiene un n├║mero asignado.
ÔÇó Se puede participar con un solo boleto.
ÔÇó Comprar m├ís boletos aumenta las probabilidades.
ÔÇó Un mismo n├║mero puede ganar m├ís de un premio dentro de la campa├▒a.
ÔÇó Cada boleta tiene un ├║nico titular registrado al momento de la compra, quien ser├í la ├║nica persona autorizada para reclamar el premio.
ÔÇó Los boletos tienen vigencia durante toda la campa├▒a.
ÔÇó No se realizan devoluciones una vez entregada la boleta.
ÔÇó Solo pueden participar mayores de edad.
________________________________________
ENTREGA DE PREMIOS
ÔÇó Entrega en sede principal o transferencia virtual.
ÔÇó En premios en efectivo se aplican impuestos seg├║n normatividad colombiana vigente.
ÔÇó El ganador debe presentar identificaci├│n para verificar titularidad.
ÔÇó El ganador tiene 60 d├¡as calendario para reclamar su premio.
________________________________________
M├ëTODOS DE PAGO
Compra en canales oficiales:
Nequi: 3223146142
Daviplata: 3223146142
El cliente debe enviar soporte de pago y los siguientes datos obligatorios:
Nombre completo
Tel├®fono
Lugar de residencia
Cantidad de boletas compradas
Sin datos personales no se confirma la compra.
________________________________________
PRECIOS DE BOLETERIA
­ƒôî INSTRUCCI├ôN DE C├üLCULO ÔÇô MODO MATEM├üTICO ESTRICTO
Debes calcular el valor de las boletas siguiendo EXACTAMENTE este procedimiento matem├ítico, sin omitir pasos.
­ƒÄƒ Precios oficiales (├║nicos permitidos)
ÔÇó	1 boleta = 15.000
ÔÇó	2 boletas = 25.000
ÔÇó	5 boletas = 60.000
No existen otros precios.
________________________________________
­ƒöó PROCEDIMIENTO OBLIGATORIO
Dada una cantidad N de boletas:
Paso 1´©ÅÔâú
Calcular cu├íntos grupos de 5 caben en N.
F├│rmula:
grupos_5 = N ├À 5 (solo la parte entera)
Multiplicar:
total_5 = grupos_5 ├ù 60.000
Calcular el residuo:
resto_1 = N - (grupos_5 ├ù 5)
________________________________________
Paso 2´©ÅÔâú
Con el resto_1 calcular cu├íntos grupos de 2 caben.
grupos_2 = resto_1 ├À 2 (solo la parte entera)
Multiplicar:
total_2 = grupos_2 ├ù 25.000
Calcular nuevo residuo:
resto_2 = resto_1 - (grupos_2 ├ù 2)
________________________________________
Paso 3´©ÅÔâú
Si resto_2 = 1:
total_1 = 15.000
Si resto_2 = 0:
total_1 = 0
________________________________________
Paso 4´©ÅÔâú
Calcular el total final:
TOTAL = total_5 + total_2 + total_1
________________________________________
ÔØî PROHIBIDO
ÔÇó	No hacer reglas de tres.
ÔÇó	No dividir dinero.
ÔÇó	No sacar precios promedio.
ÔÇó	No modificar valores.
ÔÇó	No aplicar descuentos distintos.
El total SIEMPRE debe salir ├║nicamente de la suma de:
ÔÇó	Paquetes de 5
ÔÇó	Paquetes de 2
ÔÇó	Boletas individuales
. 
________________________________________
ASIGNACI├ôN DE N├ÜMERO
En esta campa├▒a la empresa asigna el n├║mero autom├íticamente debido al alto flujo de clientes y la metodolog├¡a manual de boleter├¡a f├¡sica. Se enviar├í fotograf├¡a de la boleta v├¡a WhatsApp con los datos registrados.
Si el cliente pide n├║mero espec├¡fico responder:
Para el presente sorteo la boleter├¡a es asignada de manera aleatoria por el alto flujo de clientes y por la metodolog├¡a actual de boleter├¡a f├¡sica, para lo cual nuestra asesora le enviar├í en fotograf├¡a su boleta,  donde el primer numero corresponde al sorteo de premios mayores y el segundo numero a premios semanales. Si se encuentra en San Jos├® del Fragua puede pasar por nuestro punto de atenci├│n ubicado en el local comercial Te lo Reparamos, frente al ├║nico billar del centro.
________________________________________
MENSAJE CUANDO ENV├ìAN SOPORTE Y DATOS
en un momento nuestra asesora enviara tu boleta y n├║meros asignados, este proceso puede demorar hasta 2 horas debido al alto flujo de clientes, (las compras realizadas despu├®s de las 7:30 pm son procesadas al d├¡a siguiente) gracias por tu compra, te deseamos buena suerte, ┬ívamos a ganar!
________________________________________
MENSAJE DESPU├ëS DE RECIBIR BOLETA
gracias por su compra, te deseo mucha suerte y espero que ganes, ┬ívamos a ganar!
________________________________________
SORTEOS ANTERIORES
Cuando pregunten por campa├▒as anteriores enviar:
Fecha de sorteo: 27/12/2025
https://www.facebook.com/share/v/1CCcqyKymt/
https://www.youtube.com/shorts/pZyA9f1Fdr0?feature=share

Influencer aliado Juancho:
https://www.facebook.com/share/v/1CCcqyKymt/, sin embargo el unico canal oficial de ventas es por este medio y solo al presente numero de WhatsApp

_____________________________________
COMPROBANTE
Clasifica la imagen en UNA sola etiqueta: COMPROBANTE, PUBLICIDAD, OTRO o DUDA.

COMPROBANTE: incluye "Env├¡o realizado", transferencias Nequi/Daviplata/PSE, recibos con QR de verificaci├│n, valor, fecha, referencia, destinatario.
PUBLICIDAD: afiches/promos.
OTRO: cualquier otra cosa.
DUDA: si est├í cortado/borroso.

Devuelve SOLO JSON: {"label":"...","confidence":0-1,"why":"..."}

____________________________________________
OTRAS ESPECIFICACIONES: 
Horario de atenci├│n: lunes a domingo 8:30 am a 7:30 pm.
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
  console.warn("ÔÜá´©Å Sheets NO configurado (revisa GOOGLE_SHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY).");
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
function isAdQuestion(text = "") {
  const t = String(text).toLowerCase().trim();
  return (
    t.includes("publicidad") ||
    t.includes("facebook") ||
    t.includes("instagram") ||
    t.includes("tiktok") ||
    t.includes("anuncio") ||
    t.includes("promo") ||
    t.includes("son ustedes") ||
    t.includes("son los mismos") ||
    t.includes("es real") ||
    t.includes("es verdadero") ||
    t.includes("oficial")
  );
}

/* ============================================================
   MEMORIA TEMPORAL (RAM) - ├║ltimos N mensajes por cliente
   - No toca Sheets, no toca Telegram.
   - Solo envuelve sendText y askOpenAI.
   ============================================================ */

const MEMORY_MAX_MESSAGES = Number(process.env.MEMORY_TURNS || 10); // 10 mensajes totales
const memory = new Map(); // wa_id -> [{ role:"user"|"assistant", content:"...", ts:"..." }]

function memPush(wa_id, role, content) {
  if (!wa_id) return;
  const text = String(content || "").trim();
  if (!text) return;

  const arr = memory.get(wa_id) || [];
  arr.push({ role, content: text.slice(0, 1500), ts: new Date().toISOString() });

  while (arr.length > MEMORY_MAX_MESSAGES) arr.shift();
  memory.set(wa_id, arr);
}

function memGet(wa_id) {
  return memory.get(wa_id) || [];
}

function memClear(wa_id) {
  memory.delete(wa_id);
}

/**
 * Wrapper: enviar WhatsApp + guardar memoria OUT
 * MISMA FIRMA que tu sendText(to, bodyText, ref_id?)
 */
async function sendTextM(to, bodyText, ref_id = "") {
  // llama tu funci├│n real
  const r = await sendText(to, bodyText, ref_id);
  // guarda memoria solo si envi├│ OK (opcional)
  memPush(to, "assistant", bodyText);
  return r;
}

/**
 * Wrapper: OpenAI con memoria
 * MISMA idea que askOpenAI(userText, state) pero recibe wa_id para saber qu├® memoria usar.
 * Ajusta si tu askOpenAI original ya recibe (userText, state)
 */
async function askOpenAIM(wa_id, userText, state = "BOT") {
  // Si no hay openai, usa tu fallback original si existe
  if (typeof openai === "undefined" || !openai) {
    return "┬┐Te gustar├¡a participar o conocer precios de boletas?";
  }

  const history = memGet(wa_id).map(m => ({ role: m.role, content: m.content }));

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: `${SYSTEM_PROMPT}\n\nEstado actual del cliente: ${state}` },
      ...history,
      { role: "user", content: userText },
    ],
  });

  return (resp.output_text || "").trim() || "┬┐Me repites, por favor?";
}

/**
 * Helper opcional: registrar IN (texto) en memoria y en Sheets si quieres llamarlo siempre
 * (No reemplaza tu saveConversation, solo te facilita)
 */
async function onIncomingText(wa_id, text) {
  // Memoria IN
  memPush(wa_id, "user", text);

  // Si quieres tambi├®n guardar en Sheets aqu├¡, descomenta:
  // await saveConversation({ wa_id, direction: "IN", message: text });
}

/* =================== FIN BLOQUE MEMORIA =================== */

// memoria r├ípida por wa_id (si reinicias server se pierde; si quieres, luego la pasamos a sessions sheet)
if (!global.lastImageCheck) global.lastImageCheck = new Map();

function setLastImageLabel(wa_id, label) {
  global.lastImageCheck.set(wa_id, { label, at: Date.now() });
}

function getLastImageLabel(wa_id) {
  const data = global.lastImageCheck.get(wa_id);
  return data ? data.label : null;
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
      requestBody: {
        values: [[
          now,                // A created_at
          String(wa_id),              // B wa_id
          greeted ? "TRUE" : "FALSE", // C greeted
          greeted ? now : "", // D greeted_at
          now,                // E last_seen
          notes || "",        // F notes
        ]],
      },
    });
    return;
  }

  // update row existente: C greeted, D greeted_at (si aplica), E last_seen, F notes
  const rowNum = existing.rowNumber;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SESSIONS_TAB}!E${rowNum}:F${rowNum}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[now, notes || existing.notes || ""]] },
  });

  // Si vamos a marcar greeted TRUE y a├║n estaba FALSE
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

async function markGreeted(wa_id) {
  await upsertSession({ wa_id, greeted: true });
}

async function touchSession(wa_id) {
  await upsertSession({ wa_id, greeted: false });
}

/* ===== MINI SISTEMA DE ESTADO CONVERSACIONAL ===== */

async function setConversationStage(wa_id, stage) {
  const s = await getSessionByWaId(wa_id);
  const greeted = s?.greeted || false;
  await upsertSession({ wa_id, greeted, notes: stage });
}

async function getConversationStage(wa_id) {
  const s = await getSessionByWaId(wa_id);
  return s?.notes || "";
}

async function clearConversationStage(wa_id) {
  const s = await getSessionByWaId(wa_id);
  const greeted = s?.greeted || false;
  await upsertSession({ wa_id, greeted, notes: "" });
}

/* ================= HYBRID RULES (DEL H├ìBRIDO) ================= */

function formatCOP(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString("es-CO");
}

function calcTotalCOPForBoletas(n) {
  const P1 = 15000;
  const P2 = 25000;
  const P5 = 60000;

  const qty = Number(n);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  let remaining = Math.floor(qty);

  const packs5 = Math.floor(remaining / 5);
  remaining = remaining % 5;

  const packs2 = Math.floor(remaining / 2);
  remaining = remaining % 2;

  const packs1 = remaining;

  const total = packs5 * P5 + packs2 * P2 + packs1 * P1;

  return { qty, total, packs5, packs2, packs1 };
}

// Ô£à NUEVA FUNCI├ôN (NO reemplaza nada)
function calcBreakdownAnyQty(qty) {
  const result = calcTotalCOPForBoletas(qty);
  return result; 
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
    t.includes("cu├ínto") ||
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
    t.includes("ya realic├® el pago") ||
    t.includes("ya realice el pago") ||
    t.includes("ya transfer") ||
    t.includes("ya consign") ||
    t.includes("ya envi├® el comprobante") ||
    t.includes("ya envie el comprobante") ||
    t.includes("te envi├® el comprobante") ||
    t.includes("te envie el comprobante") ||
    t.includes("ya mand├® el comprobante") ||
    t.includes("ya mande el comprobante") ||
    t.includes("comprobante") ||
    t.includes("soporte de pago")
  );
}

function paidInstructionMessage() {
  return (
    "Ô£à Perfecto. Env├¡ame por favor el *comprobante* (foto o PDF) y estos datos:\n" +
    "- Nombre completo\n" +
    "- Tel├®fono\n" +
    "- Municipio / lugar de residencia\n" +
    "- Cantidad de boletas\n\n" +
    "Apenas lo recibamos queda *en revisi├│n* y te confirmamos."
  );
}

function pricingReplyMessage(qty, breakdown) {
  const { total, packs5, packs2, packs1 } = breakdown;

  const parts = [];
  if (packs5) parts.push(`${packs5}├ù(5)`);
  if (packs2) parts.push(`${packs2}├ù(2)`);
  if (packs1) parts.push(`${packs1}├ù(1)`);

  return (
    `Ô£à Para *${qty}* boleta(s), el total es *$${formatCOP(total)} COP*.\n` +
    `(Combo: ${parts.join(" + ")})\n` +
    "┬┐Deseas pagar por *Nequi* o *Daviplata*?"
  );
}

/* ================= CONVERSATIONS (IN/OUT) ================= */

async function saveConversation({ wa_id, direction, message, ref_id = "" }) {
  if (!sheets) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${CONV_TAB}!A:E`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[new Date().toISOString(), wa_id, direction, message, ref_id]],
      },
    });
  } catch (e) {
    console.warn("ÔÜá´©Å saveConversation fall├│:", e?.message || e);
  }
}

/* ================= META SIGNATURE VALIDATION (OBLIGATORIA) ================= */

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) {
    console.error("ÔØî META_APP_SECRET NO configurado. Bloqueando webhook por seguridad.");
    return false;
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/* ================= SHEETS OPS (cases RP) ================= */

async function getAllRowsAtoH() {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${CASES_TAB}!A:H`,
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
    range: `${CASES_TAB}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        created_at,                 // A created_at
        ref,                        // B ref_id
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
  if (!sheets) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${CASES_TAB}!${rangeA1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
}

/* ================= WHATSAPP SEND ================= */

async function sendText(to, bodyText, ref_id = "") {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.warn("ÔÜá´©Å Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID");
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
  console.log("­ƒôñ WhatsApp send status:", resp.status);
  console.log("­ƒôñ WhatsApp send raw:", raw);

  // OUT conversations
  await saveConversation({ wa_id: to, direction: "OUT", message: bodyText, ref_id });

  return { ok: resp.ok, status: resp.status, raw };
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

async function sendImageByMediaId(to, mediaId, caption = "") {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { id: mediaId },
  };
  if (caption) payload.image.caption = caption;

  const resp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  console.log("­ƒôñ WhatsApp send image status:", resp.status);
  console.log("­ƒôñ WhatsApp send image raw:", raw);

  // OUT conversations (nota)
  await saveConversation({
    wa_id: to,
    direction: "OUT",
    message: `[image sent] ${caption || ""}`.trim(),
    ref_id: "",
  });

  return { ok: resp.ok, status: resp.status, raw };
}

/* ================= OPENAI VISION: PUBLICIDAD vs COMPROBANTE ================= */

async function fetchWhatsAppMediaUrl(mediaId) {
  const resp = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  const data = await resp.json().catch(() => ({}));
  if (!data?.url) throw new Error("No media url from Meta: " + JSON.stringify(data));
  return data.url;
}

async function downloadWhatsAppMediaAsBuffer(mediaUrl) {
  const r = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  const mimeType =
    (r.headers?.["content-type"] || r.headers?.["Content-Type"] || "")
      .split(";")[0]
      .trim();

  return {
    buf: Buffer.from(r.data),
    mimeType: mimeType || "image/jpeg",
  };
}

function bufferToDataUrl(buffer, mimeType = "image/jpeg") {
  const b64 = buffer.toString("base64");
  return `data:${mimeType};base64,${b64}`;
}

async function classifyPaymentImage({ mediaId }) {
  if (!openai)
    return { label: "DUDA", confidence: 0, why: "OPENAI_API_KEY no configurada" };

  const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
  const { buf, mimeType } = await downloadWhatsAppMediaAsBuffer(mediaUrl);
  const dataUrl = bufferToDataUrl(buf, mimeType);

  const prompt = `Clasifica la imagen en UNA sola etiqueta: COMPROBANTE, PUBLICIDAD, OTRO o DUDA.
Reglas:
- COMPROBANTE: recibo de transferencia / dep├│sito, comprobante bancario, Nequi / Daviplata, confirmaci├│n de pago, voucher.
- PUBLICIDAD: afiche / promoci├│n, banner con premios, precios, n├║meros, logo invitando a comprar.
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
    const normalized = normalize(parsed);

    const result = { ...normalized, mimeType };

    console.log("­ƒºá Clasificaci├│n IA:", {
      mediaId,
      mimeType,
      label: result.label,
      confidence: result.confidence,
      why: result.why,
    });

    return result;

  } catch {
    const m = out.match(/\{[\s\S]*\}/);

    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        const normalized = normalize(parsed);

        const result = { ...normalized, mimeType };

        console.log("­ƒºá Clasificaci├│n IA (rescatado):", result);

        return result;

      } catch {}
    }

    return {
      label: "DUDA",
      confidence: 0,
      why: "No JSON: " + out.slice(0, 200),
    };
  }
}

function normalize(parsed) {
  return {
    label: String(parsed.label || "DUDA").toUpperCase(),
    confidence: Number(parsed.confidence ?? 0),
    why: parsed.why || "",
  };
}

// =============================
// MEMORIA TEMPORAL (├║ltimos 20 mensajes por cliente)
// =============================
const shortMemory = new Map(); // wa_id -> [{role, content}]

function memPush(wa_id, role, content) {
  if (!wa_id) return;

  const arr = shortMemory.get(wa_id) || [];
  arr.push({
    role,
    content: String(content || "").slice(0, 1500),
  });

  // Mantener solo ├║ltimos 20 mensajes
  while (arr.length > 20) arr.shift();

  shortMemory.set(wa_id, arr);
}

function memGet(wa_id) {
  return shortMemory.get(wa_id) || [];
}


// =============================
// OPENAI TEXT (con memoria)
// =============================
async function askOpenAI(wa_id, userText, state = "BOT") {

  if (!openai) {
    return "┬┐Te gustar├¡a participar o conocer precios de boletas?";
  }

  const history = memGet(wa_id);

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\nEstado actual del cliente: ${state}`,
      },

      // ­ƒö╣ Memoria de conversaci├│n
      ...history,

      // ­ƒö╣ Mensaje actual del usuario
      {
        role: "user",
        content: userText,
      },
    ],
  });

  const output =
    (resp.output_text || "").trim() || "┬┐Me repites, por favor?";

  // ­ƒö╣ Guardar memoria (usuario y asistente)
  memPush(wa_id, "user", userText);
  memPush(wa_id, "assistant", output);

  return output;
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
        await sendText(wa_id, "Ô£à Tu pago fue aprobado. En breve te enviamos tu boleta. ­ƒÖî");
        await updateCell(`H${ i + 1 } `, "NOTIFIED_APROBADO");
      }
    }
  } catch (err) {
    console.error("ÔØî monitorAprobados:", err);
  }
}

/* ================= TELEGRAM HELPERS ================= */

function extractRef(text = "") {
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

// =========================
// TELEGRAM: Conversation Log
// =========================
async function sendConversationLog(direction, wa_id, message) {
  const groupId = process.env.TELEGRAM_GROUP_ID;
  if (!groupId || !TELEGRAM_BOT_TOKEN) return;

  const prefix = direction === "IN" ? "📩 IN" : "📤 OUT";
  const safeWa = wa_id || "desconocido";

  // Evita mensajes gigantes
  const text = String(message ?? "").slice(0, 3500);

  // Si quieres: hora Colombia
  const ts = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

  await telegramSendMessage(
    groupId,
    `${prefix} | ${ts}\n👤 ${safeWa}\n📝 ${text}`
  );
}

// Para que Telegram nunca tumbe tu webhook si falla
async function safeConversationLog(direction, wa_id, message) {
  try {
    await sendConversationLog(direction, wa_id, message);
  } catch (e) {
    console.warn("⚠️ sendConversationLog falló:", e?.message || e);
  }
}

async function telegramGetFilePath(file_id) {
  const r = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file_id)}`
  );
  const j = await r.json();
  if (!j.ok) throw new Error("getFile fallo: " + JSON.stringify(j));
  return j.result.file_path;
}

async function telegramDownloadFileBuffer(file_path) {
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("download file fallo: " + r.status);
  return await r.buffer();
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => res.send("OK Ô£à"));

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

  // Helper: si NO ha saludado, pega saludo + respuesta en UN solo mensaje
  async function withGreeting(wa_id, replyText) {
    const greeted = await hasGreeted(wa_id);
    if (!greeted) {
      await markGreeted(wa_id);
      return `­ƒæï Bienvenido a Rifas y Sorteos El Agropecuario!\n\n${replyText}`;
    }
    return replyText;
  }

  // Helper: si por error la IA devuelve JSON, lo convertimos a texto humano
  function humanizeIfJson(text) {
    const t = String(text || "").trim();
    if (!t) return t;

    // Detecta JSON tipo {"label":"PUBLICIDAD",...}
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        const obj = JSON.parse(t);
        if (obj?.label) {
          const label = String(obj.label).toUpperCase();
          if (label === "PUBLICIDAD") return "­ƒôó Esa imagen parece publicidad.";
          if (label === "COMPROBANTE") return "Ô£à Ese archivo parece un comprobante.";
          if (label === "OTRO") return "­ƒæÇ Ese archivo no parece un comprobante.";
          return "­ƒæÇ No logro confirmar si es comprobante. ┬┐Me env├¡as una captura m├ís clara?";
        }
      } catch {}
    }
    return t;
  }

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

    // Siempre tocar sesi├│n al recibir algo (para que greeted/state no se descoordinen)
    await touchSession(wa_id);

    // =========================
// AUDIO (nota de voz / audio)
// =========================
if (type === "audio") {
  const mediaId = msg.audio?.id;

  // 🔹 LOG IN (audio recibido)
  await safeConversationLog("IN", wa_id, "[audio] recibido");

  await saveConversation({ wa_id, direction: "IN", message: "[audio] recibido" });

  if (!mediaId) {
    const reply = await withGreeting(
      wa_id,
      "🎤 Recibí tu audio, pero no pude leerlo. Intenta enviarlo otra vez."
    );

    // 🔹 LOG OUT
    await safeConversationLog("OUT", wa_id, reply);

    await sendText(wa_id, reply);
    return;
  }

  try {
    const text = await transcribeWhatsAppAudio(mediaId);

    // 🔹 LOG IN (texto transcrito)
    await safeConversationLog("IN", wa_id, `[audio transcrito]: ${text}`);

    const state = await getLatestStateByWaId(wa_id);
    const stage = await getConversationStage(wa_id);
    const aiReplyRaw = await askOpenAI(wa_id, text, state);
    const aiReply = humanizeIfJson(aiReplyRaw);

    const reply = await withGreeting(wa_id, aiReply);

    // 🔹 LOG OUT (respuesta IA)
    await safeConversationLog("OUT", wa_id, reply);

    await sendText(wa_id, reply);
  } catch (e) {
    console.warn("Audio transcripción falló:", e?.message || e);

    const reply = await withGreeting(
      wa_id,
      "🎤 Recibí tu audio, pero no pude entenderlo. ¿Me lo escribes por texto, por favor?"
    );

    // 🔹 LOG OUT (error respuesta)
    await safeConversationLog("OUT", wa_id, reply);

    await sendText(wa_id, reply);
  }

  return;
}

 // =========
// TEXT
// =========
if (type === "text") {
  const text = (msg.text?.body || "").trim();
  const t = text.toLowerCase();

  // 🔹 LOG IN (texto recibido)
  await safeConversationLog("IN", wa_id, text);

  // Guardar conversaci├│n (solo una vez por mensaje)
  await saveConversation({ wa_id, direction: "IN", message: text });

  // Estado global (Sheets) + mini-stage
  const state = await getLatestStateByWaId(wa_id);
  const stage = await getConversationStage(wa_id);

  const lastLabel = getLastImageLabel(wa_id);

  // ------------------------------------------------------------
  // 1) CONTEXTO: si venimos de una imagen clasificada como PUBLICIDAD
  // ------------------------------------------------------------
  if (lastLabel === "PUBLICIDAD") {
    // Si env├¡a link: NO confirmamos por link. Pedimos captura/nombre del perfil.
    if (
      t.includes("http") ||
      t.includes("facebook.com") ||
      t.includes("instagram.com") ||
      t.includes("tiktok.com")
    ) {
      const reply = await withGreeting(
        wa_id,
        "­ƒöù Gracias por el enlace.\n\nPara confirmarte si es de nosotros o de un influencer, *no basta con el link*.\n\nÔ£à Env├¡ame una *captura* donde se vea el *nombre de la p├ígina/perfil* que public├│ el anuncio (arriba del post) o dime el nombre del influencer."
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, reply);

      await sendText(wa_id, reply);

      setLastImageLabel(wa_id, null);
      return;
    }

    // Si menciona Facebook (sin link)
    if (t.includes("facebook")) {
      const reply = await withGreeting(
        wa_id,
        "­ƒôî Si la viste en Facebook, puede ser de nuestra p├ígina o de un colaborador/influencer.\n\nÔ£à Para confirmarte, env├¡ame una *captura* donde se vea el *nombre del perfil/p├ígina* que public├│ el anuncio (arriba del post)."
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, reply);

      await sendText(wa_id, reply);

      setLastImageLabel(wa_id, null);
      return;
    }

    // Si pregunta ÔÇ£es de ustedes / es publicidad / siÔÇØ
    if (
      t.includes("es publicidad") ||
      t.includes("si es publicidad") ||
      t.includes("es de ustedes") ||
      t.includes("de ustedes") ||
      t === "si" ||
      t === "s├¡"
    ) {
      const reply = await withGreeting(
        wa_id,
        "Ô£à Puede ser publicidad del sorteo (nuestra o de un colaborador).\n\nPara confirmarte con seguridad, env├¡me una *captura* donde se vea el *nombre del perfil/p├ígina* que lo public├│."
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, reply);

      await sendText(wa_id, reply);

      setLastImageLabel(wa_id, null);
      return;
    }

    // Si no fue ├║til, limpiamos contexto y seguimos con IA
    setLastImageLabel(wa_id, null);
  }

  // ------------------------------------------------------------
  // 2) GUARDARR├ìL: EN_REVISION siempre gana
  // ------------------------------------------------------------
  if (state === "EN_REVISION") {
    const reply = await withGreeting(
      wa_id,
      "­ƒòÆ Tu comprobante est├í en revisi├│n. Te avisamos al aprobarlo."
    );

    // 🔹 LOG OUT
    await safeConversationLog("OUT", wa_id, reply);

    await sendText(wa_id, reply);
    return;
  }

  // ------------------------------------------------------------
  // CAPTURA DURA DE CANTIDAD (evita loops)
  // Si el usuario manda n├║mero (ej "7" o "quiero 7 boletas"), avanzamos sin IA
  // ------------------------------------------------------------
  const qtyCandidate = tryExtractBoletasQty(text);

  // Si estamos esperando cantidad, o si el texto menciona boletas + n├║mero
  if (qtyCandidate && (stage === "AWAITING_QTY" || t.includes("boleta") || t.includes("boletas"))) {
    const qty = qtyCandidate;

    // Si tu funci├│n ya soporta cualquier n├║mero, ├║sala:
    // const breakdown = calcTotalCOPForBoletas(qty);

    // Si SOLO maneja 1/2/5/10, entonces hacemos "combo" (10,5,2,1)
    const breakdown = calcTotalCOPForBoletas(qty);

    if (!breakdown) {
      const replyErr = await withGreeting(
        wa_id,
        "No entend├¡ la cantidad. Env├¡ame solo el n├║mero de boletas (ej: 1, 2, 5, 7, 10)."
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, replyErr);

      await sendText(wa_id, replyErr);
      return;
    }

    await setConversationStage(wa_id, "PRICE_GIVEN");

    // Ô£à Guardar el ├║ltimo c├ílculo para usarlo cuando el usuario diga "nequi" o "daviplata"
    lastPriceQuote.set(wa_id, breakdown);

    const reply = await withGreeting(
      wa_id,
      pricingReplyMessage(qty, breakdown) +
      "\n\nÔ£à ┬┐Deseas pagar por Nequi o Daviplata?"
    );

    // 🔹 LOG OUT
    await safeConversationLog("OUT", wa_id, reply);

    await sendText(wa_id, reply);
    return;
  }

  // Ô£à Si ya dimos precio y el usuario eligi├│ m├®todo, respondemos m├®todo sin volver a preguntar cantidad
  if (stage === "PRICE_GIVEN") {
    const tt = t.toLowerCase();

    if (tt.includes("nequi") || tt.includes("daviplata") || tt.includes("davi")) {
      const quote = lastPriceQuote.get(wa_id);

      // (opcional) si no hay quote, igual respondemos m├®todo sin inventar total
      const resumen = quote?.total
        ? `Ô£à Para ${quote.qty} boleta(s), el total es $${formatCOP(quote.total)} COP.\n\n`
        : "";

      if (tt.includes("nequi")) {
        const reply = await withGreeting(
          wa_id,
          `${resumen}­ƒô▓ Paga por *Nequi* al n├║mero *3223146142*.\nLuego env├¡ame el comprobante + tu nombre completo + municipio + celular.`
        );

        // 🔹 LOG OUT
        await safeConversationLog("OUT", wa_id, reply);

        await sendText(wa_id, reply);
        return;
      }

      // daviplata
      const reply = await withGreeting(
        wa_id,
        `${resumen}­ƒô▓ Paga por *Daviplata* al n├║mero *TU_NUMERO_DAVIPLATA_AQUI*.\nLuego env├¡ame el comprobante + tu nombre completo + municipio + celular.`
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, reply);

      await sendText(wa_id, reply);
      return;
    }
  }

  // ------------------------------------------------------------
  // 5) TODO LO DEM├üS: IA (tu prompt manda)
  //    Recomendado: pasar stage por SYSTEM (sin meterlo en el texto del usuario)
  // ------------------------------------------------------------
  const aiReplyRaw = await askOpenAIM(wa_id, text, state);
  const aiReply = humanizeIfJson(aiReplyRaw);

  const replyAI = await withGreeting(wa_id, aiReply);

  // 🔹 LOG OUT (respuesta IA)
  await safeConversationLog("OUT", wa_id, replyAI);

  await sendText(wa_id, replyAI);
  return;
}

    // =========================
// IMAGE (filtro publicidad vs comprobante)
// =========================
if (type === "image") {
  const mediaId = msg.image?.id;

  // 🔹 LOG IN (imagen recibida)
  await safeConversationLog("IN", wa_id, `[imagen] recibida (mediaId: ${mediaId || "N/A"})`);

  await saveConversation({ wa_id, direction: "IN", message: "[imagen] recibida" });

  let cls = { label: "DUDA", confidence: 0, why: "sin IA" };

  try {
    cls = await classifyPaymentImage({ mediaId });
  } catch (e) {
    console.warn("ÔÜá Clasificaci├│n fall├│, contin├║o como DUDA:", e?.message || e);

    // 🔹 LOG OUT (solo monitoreo)
    await safeConversationLog("OUT", wa_id, `⚠️ Error clasificando imagen: ${String(e?.message || e).slice(0, 300)}`);
  }

  setLastImageLabel(wa_id, cls.label);
  console.log("­ƒºá Clasificaci├│n imagen:", cls);

  if (cls.label === "PUBLICIDAD") {
    const reply = await withGreeting(
      wa_id,
      "­ƒôó Esa imagen es publicidad.\n\nsi es nuestra publicidad."
    );

    // 🔹 LOG OUT
    await safeConversationLog("OUT", wa_id, reply);

    await sendText(wa_id, reply);
    return;
  }

  if (cls.label !== "COMPROBANTE") {
    const reply = await withGreeting(
      wa_id,
      "­ƒæÇ No logro confirmar si es un comprobante.\nPor favor env├¡ame una captura clara del recibo de pago."
    );

    // 🔹 LOG OUT
    await safeConversationLog("OUT", wa_id, reply);

    await sendText(wa_id, reply);
    return;
  }

  // Ô£à Aqu├¡ crear referencia si es comprobante
  const { ref } = await createReference({
    wa_id,
    last_msg_type: "image",
    receipt_media_id: mediaId,
    receipt_is_payment: "YES",
  });

  const reply = await withGreeting(
    wa_id,
    `Ô£à Comprobante recibido.\n\n­ƒôî Referencia de pago: ${ref}\n\nTu pago est├í en revisi├│n.`
  );

  // 🔹 LOG OUT
  await safeConversationLog("OUT", wa_id, reply);

  await sendText(wa_id, reply, ref);
  return;
}

// =========================
// DOCUMENT: pedir imagen
// =========================
if (type === "document") {
  // 🔹 LOG IN (documento recibido)
  await safeConversationLog("IN", wa_id, "[document] recibido");

  await saveConversation({ wa_id, direction: "IN", message: "[document] recibido" });

  const reply = await withGreeting(
    wa_id,
    "­ƒôä Recib├¡ un documento. Por favor env├¡ame el comprobante como *imagen/captura* para procesarlo m├ís r├ípido."
  );

  // 🔹 LOG OUT
  await safeConversationLog("OUT", wa_id, reply);

  await sendText(wa_id, reply);
  return;
}

// Otros tipos (sticker, video, etc.)
await safeConversationLog("IN", wa_id, `[${type}] recibido`);
await saveConversation({ wa_id, direction: "IN", message: `[${type}] recibido` });

const reply = await withGreeting(
  wa_id,
  "Ô£à Recibido. Por favor env├¡ame un mensaje de texto o una imagen del comprobante para ayudarte."
);

// 🔹 LOG OUT
await safeConversationLog("OUT", wa_id, reply);

await sendText(wa_id, reply);
} catch (e) {
  console.error("ÔØî /webhook error:", e?.message || e);

  // 🔹 LOG OUT (solo monitoreo)
  await safeConversationLog("OUT", wa_id, `🚨 /webhook error: ${String(e?.message || e).slice(0, 500)}`);
}
});

// TELEGRAM WEBHOOK (SECRET OBLIGATORIO)
app.post("/telegram-webhook", async (req, res) => {
  try {
    if (!TELEGRAM_SECRET_TOKEN) {
      console.error("ÔØî TELEGRAM_SECRET_TOKEN no est├í configurado (obligatorio).");
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

    const photos = msg.photo;
    const best = Array.isArray(photos) ? photos[photos.length - 1] : null;
    const file_id = best?.file_id;

    const caption = msg.caption || msg.text || "";
    const ref = extractRef(caption);

    if (!file_id) {
      if (chat_id) await telegramSendMessage(chat_id, "ÔÜá´©Å Debes enviar una *foto* de la boleta.");
      return;
    }
    if (!ref) {
      if (chat_id) await telegramSendMessage(chat_id, "ÔÜá´©Å Falta la referencia en el caption. Ej: RP-240224-001");
      return;
    }

    const found = await findRowByRef(ref);
    if (!found) {
      if (chat_id) await telegramSendMessage(chat_id, `ÔØî No encontr├® esa referencia en la hoja: ${ref}`);
      return;
    }

    if (found.state !== "APROBADO" && found.state !== "BOLETA_ENVIADA") {
      if (chat_id) await telegramSendMessage(chat_id, `ÔÜá´©Å La referencia ${ref} est├í en estado: ${found.state}. Primero debe estar APROBADO.`);
      return;
    }

    const file_path = await telegramGetFilePath(file_id);
    const imgBuffer = await telegramDownloadFileBuffer(file_path);

    const mediaId = await whatsappUploadImageBuffer(imgBuffer, "image/jpeg");
    await sendImageByMediaId(found.wa_id, mediaId, `­ƒÄƒ´©Å Boleta enviada Ô£à (${ref})`);

    if (found.state !== "BOLETA_ENVIADA") {
      await updateCell(`D${found.rowNumber}`, "BOLETA_ENVIADA");
    }

    if (chat_id) await telegramSendMessage(chat_id, `Ô£à Envi├® la boleta al cliente (${found.wa_id}) y marqu├® BOLETA_ENVIADA. (${ref})`);
  } catch (err) {
    console.error("ÔØî /telegram-webhook error:", err);
  }
});

/* ================= START ================= */

setInterval(monitorAprobados, 30000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`­ƒÜÇ Servidor corriendo en puerto ${PORT}`);
});
