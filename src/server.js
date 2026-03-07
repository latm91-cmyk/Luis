// ===== server.js (AVANZADO + HÍBRIDO, SIN BORRAR FUNCIONES) =====
require("dotenv").config();
console.log("GEMINI_API_KEY:", process.env.GEMINI_API_KEY ? "CARGADA ✅" : "NO CARGADA ❌");
const express = require("express");
const { google } = require("googleapis");
const fetch = require("node-fetch"); // v2
const crypto = require("crypto");
const FormData = require("form-data");
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
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL_TEXT = process.env.GEMINI_MODEL_TEXT || "gemini-2.0-flash";
const GEMINI_MODEL_VISION = process.env.GEMINI_MODEL_VISION || "gemini-2.0-flash";

// Control follow-up de ventas (1 solo recordatorio)
const followUps = new Map();

// Último precio calculado por usuario (para no repetir preguntas)
const lastPriceQuote = new Map(); // wa_id -> { qty, total, packs5, packs2, packs1 }


async function geminiGenerateContent({ model, systemInstruction = "", contents = [] }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY no configurada");
  }

  const selectedModel = String(model || "").trim() || "gemini-1.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
  contents,
};

if (systemInstruction) {
  contents.unshift({
    role: "user",
    parts: [{ text: systemInstruction }],
  });
}

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Gemini API error: ${resp.status} ${JSON.stringify(data)}`);
  }

  if (data?.promptFeedback?.blockReason) {
    throw new Error(`Gemini bloqueó el prompt: ${data.promptFeedback.blockReason}`);
  }

  const firstCandidate = data?.candidates?.[0] || {};
  const finishReason = firstCandidate?.finishReason || "";
  const joinedText =
    firstCandidate?.content?.parts
      ?.map((p) => p.text || "")
      .join("\n")
      .trim() || "";

  if (!joinedText) {
    throw new Error(`Gemini sin texto (finishReason=${finishReason || "N/A"})`);
  }

  return joinedText;
}

/* ================= PROMPT PRO (DEL HÍBRIDO) ================= */

const SYSTEM_PROMPT = `
Eres un agente de atención al cliente y promotor experto, profesional y persuasivo de Rifas y Sorteos El Agropecuario. Tu objetivo es ayudar a los clientes de manera eficaz, promocionando informacin clara, precisa y transparente, guiándolos hacia la compra de boletos y generando confianza en todo momento.
Objetivo: ayudar a vender boletas y guiar al cliente hasta enviar comprobante, con respuestas cortas y claras.

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
En la actual campaña tenemos Premio semanal: $500.000 pesos colombianos acumulables, 
Premio mayor: Lote de 5 novillas preñadas y un torete, avaluado en $18.000.000 de pesos, 
Segundo premio: $15.000.000 en efectivo, 
Tercer premio: Moto Suzuki DR 150 FI, avaluada en $13.000.000, 
Cuarto premio: iPhone 17 Pro Max, avaluado en $6.500.000. 
Nuestros sorteos se realizan tomando como base los resultados oficiales de las loterías correspondientes, garantizando total transparencia. 

¿Quieres conocer las reglas del sorteo?
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

____________________________________________
FECHAS DE SORTEO:

Premio semanal acumulable:  Se juega todos los viernes desde el 30 de enero hasta el 25 de abril. 

Premio mayor: Se juega el 25 de abril de 2026.

Segundo premio: Se juega el 18 de abril de 2026.

Tercer premio: Se juega el 11 de abril de 2026.

Cuarto premio: Se juega el 4 de abril de 2026
________________________________________
EMPRESA Y RESPALDO

Responsables: Inversiones El Agropecuario, representado por el señor Miguel Torres.
Ubicación: San José del Fragua, Caquetá, Colombia.
Participación mediante boletería registrada y transmisión en vivo por redes sociales.
Redes sociales: 
https://www.facebook.com/profile.php?id=61588354538179&locale=es_LA
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
Paso 1:
Calcular cuántos grupos de 5 caben en N.
Fórmula:
grupos_5 = N À 5 (solo la parte entera)
Multiplicar:
total_5 = grupos_5 × 60.000
Calcular el residuo:
resto_1 = N - (grupos_5 × 5)
________________________________________
Paso 2:
Con el resto_1 calcular cuántos grupos de 2 caben.
grupos_2 = resto_1 À 2 (solo la parte entera)
Multiplicar:
total_2 = grupos_2 × 25.000
Calcular nuevo residuo:
resto_2 = resto_1 - (grupos_2 × 2)
________________________________________
Paso 3:
Si resto_2 = 1:
total_1 = 15.000
Si resto_2 = 0:
total_1 = 0
________________________________________
Paso 4:
Calcular el total final:
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
En esta campaña la empresa asigna el número automáticamente (es decir el cliente no escoge su número) debido al alto flujo de clientes y la metodología manual de boletería física. Se enviará fotografía de la boleta vía WhatsApp con los datos enviados por el cliente.
Si el cliente pide número específico responder:

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

Influencer aliado Juancho:
https://www.facebook.com/share/v/1CCcqyKymt/
 
influencer aliado carnada de tiburón:
https://www.facebook.com/share/p/1B471oxnKX/

sin embargo, el único canal oficial de ventas es por este medio y solo al presente número de WhatsApp.
_____________________________________
COMPROBANTE
Clasifica la imagen en UNA sola etiqueta: COMPROBANTE, PUBLICIDAD, OTRO o DUDA.

COMPROBANTE: incluye "Envío realizado", transferencias Nequi/Daviplata/PSE, recibos con QR de verificación, valor, fecha, referencia, destinatario.
PUBLICIDAD: afiches/promos.
OTRO: cualquier otra cosa.
DUDA: si est cortado/borroso.

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
   MEMORIA TEMPORAL (RAM) - últimos N mensajes por cliente
   - No toca Sheets, no toca Telegram.
   - Solo envuelve sendText y askGemini.
   ============================================================ */

const MEMORY_MAX_MESSAGES_LEGACY = Number(process.env.MEMORY_TURNS || 10); // 10 mensajes totales
const memory_LEGACY = new Map(); // wa_id -> [{ role:"user"|"assistant", content:"...", ts:"..." }]

const shortMemory = new Map();
function memPush(wa_id, role, content) {
  if (!wa_id) return;
  const text = String(content || "").trim();
  if (!text) return;

  const arr = memory.get(wa_id) || [];
  // Mapear roles para consistencia interna (user/assistant)
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
  // llama tu función real
  const r = await sendText(to, bodyText, ref_id);
  // guarda memoria solo si envió OK (opcional)
  memPush(to, "assistant", bodyText);
  return r;
}

/**
 * Wrapper: Gemini con memoria
 * MISMA idea que askGemini(userText, state) pero recibe wa_id para saber qu® memoria usar.
 * Ajusta si tu askGemini original ya recibe (userText, state)
 */
async function askGeminiM(wa_id, userText, state = "BOT") {
  // Delegar a askGemini para mantener una sola lógica de IA + memoria
  return await askGemini(wa_id, userText, state);
}

/**
 * Helper opcional: registrar IN (texto) en memoria y en Sheets si quieres llamarlo siempre
 * (No reemplaza tu saveConversation, solo te facilita)
 */
async function onIncomingText(wa_id, text) {
  // Memoria IN
  memPush(wa_id, "user", text);

  // Si quieres tambi®n guardar en Sheets aquí, descomenta:
  // await saveConversation({ wa_id, direction: "IN", message: text });
}

/* =================== FIN BLOQUE MEMORIA =================== */

// memoria rápida por wa_id (si reinicias server se pierde; si quieres, luego la pasamos a sessions sheet)
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

  // Si vamos a marcar greeted TRUE y aún estaba FALSE
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

/* ================= HYBRID RULES (DEL HÍBRIDO) ================= */

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

// ✅ NUEVA FUNCIÓN (NO reemplaza nada)
function calcBreakdownAnyQty(qty) {
  const result = calcTotalCOPForBoletas(qty);
  return result; 
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
    t.includes("ya realice el pago") ||
    t.includes("ya realice el pago") ||
    t.includes("ya transfer") ||
    t.includes("ya consigne") ||
    t.includes("ya envie el comprobante") ||
    t.includes("ya envie el comprobante") ||
    t.includes("te envie el comprobante") ||
    t.includes("te envie el comprobante") ||
    t.includes("ya mande el comprobante") ||
    t.includes("ya mande el comprobante") ||
    t.includes("comprobante") ||
    t.includes("soporte de pago")
  );
}

function paidInstructionMessage() {
  return (
    "✅ Perfecto. Envíame por favor el *comprobante* (foto o PDF) y estos datos:\n" +
    "- Nombre completo\n" +
    "- Teléfono\n" +
    "- Municipio / lugar de residencia\n" +
    "- Cantidad de boletas\n\n" +
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
    "Deseas pagar por *Nequi* o *Daviplata*?"
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
    console.warn("⚠️ saveConversation fall:", e?.message || e);
  }
}

/* ================= META SIGNATURE VALIDATION (OBLIGATORIA) ================= */

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) {
    console.error("❌ META_APP_SECRET NO configurado. Bloqueando webhook por seguridad.");
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
    console.warn("⚠️ Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID");
    console.error("❌ Error CRÍTICO: Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID. Revisa tus variables de entorno.");
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
  console.log(" WhatsApp send status:", resp.status);
  console.log(" WhatsApp send raw:", raw);
  
  if (!resp.ok) {
    console.error(`❌ Error enviando mensaje a WhatsApp (${resp.status}):`, raw);
  } else {
    console.log("✅ Mensaje enviado correctamente a WhatsApp.");
  }

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
  console.log(" WhatsApp send image status:", resp.status);
  console.log(" WhatsApp send image raw:", raw);

  // OUT conversations (nota)
  await saveConversation({
    wa_id: to,
    direction: "OUT",
    message: `[image sent] ${caption || ""}`.trim(),
    ref_id: "",
  });

  return { ok: resp.ok, status: resp.status, raw };
}

/* ================= GEMINI VISION: PUBLICIDAD vs COMPROBANTE ================= */

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

async function classifyPaymentImage({ mediaId }) {
  if (!GEMINI_API_KEY)
    return { label: "DUDA", confidence: 0, why: "GEMINI_API_KEY no configurada" };

  const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
  const { buf, mimeType } = await downloadWhatsAppMediaAsBuffer(mediaUrl);
  const b64Image = buf.toString("base64");

  const prompt = `Clasifica la imagen en UNA sola etiqueta: COMPROBANTE, PUBLICIDAD, OTRO o DUDA.
Reglas:
- COMPROBANTE: recibo de transferencia / depósito, comprobante bancario, Nequi / Daviplata, confirmación de pago, voucher.
- PUBLICIDAD: afiche / promoción, banner con premios, precios, números, logo invitando a comprar.
Devuelve SOLO JSON: {"label":"...","confidence":0-1,"why":"..."}`;

  const out = (
    await geminiGenerateContent({
      model: GEMINI_MODEL_VISION,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { data: b64Image, mimeType } },
          ],
        },
      ],
    })
  ).trim();

  try {
    const parsed = JSON.parse(out);
    const normalized = normalize(parsed);

    const result = { ...normalized, mimeType };

    console.log("🧠 Clasificación IA:", {
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

        console.log("🧠 Clasificación IA (rescatado):", result);

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
// GEMINI TEXT (estable)
// =============================

function memPush(wa_id, role, content) {
  if (!wa_id) return;

  const arr = shortMemory.get(wa_id) || [];
  arr.push({
    role,
    content: String(content || "").slice(0, 1500),
  });

  // Mantener solo últimos 20 mensajes
  while (arr.length > 20) arr.shift();

  shortMemory.set(wa_id, arr);
}

function memGet(wa_id) {
  return shortMemory.get(wa_id) || [];
}


// =============================
// GEMINI TEXT (con memoria)
// =============================
async function askGemini(wa_id, userText, state = "BOT") {
  if (!GEMINI_API_KEY) {
    return "Te gustaría participar o conocer precios de boletas?";
  }

  const history = memGet(wa_id);
  const contents = history
    .map((msg) => {
      const role = msg.role === "assistant" ? "model" : "user";
      const text = String(msg.content || "").trim();
      if (!text) return null;
      return { role, parts: [{ text }] };
    })
    .filter(Boolean);

  contents.push({
    role: "user",
    parts: [{ text: String(userText || "") }],
  });

  const outputRaw = await geminiGenerateContent({
    model: GEMINI_MODEL_TEXT,
    systemInstruction: `${SYSTEM_PROMPT}\n\nEstado actual del cliente: ${state}`,
    contents,
  }).catch((error) => {
    console.error("❌ Error Gemini texto:", error?.message || error);
    return "Lo siento, estoy teniendo problemas de conexión. ¿Podrías repetirme eso?";
  });

  const output = String(outputRaw || "").trim() || "Me repites, por favor?";

  // Guardar memoria (usuario y asistente)
  memPush(wa_id, "user", userText);
  memPush(wa_id, "assistant", output);

return output;}

/* ================= MONITOR APROBADOS ================= */

async function monitorAprobados() {
  if (!sheets) return;

  const rows = await getAllRowsAtoH().catch((err) => {
    console.error("❌ monitorAprobados (getAllRowsAtoH):", err);
    return [];
  });

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const wa_id = row?.[2];
    const state = row?.[3];
    const notes = row?.[7];

    if (state === "APROBADO" && notes !== "NOTIFIED_APROBADO") {
      await sendText(wa_id, "✅ Tu pago fue aprobado. En breve te enviamos tu boleta.").catch((err) => {
        console.error("❌ monitorAprobados (sendText):", err);
      });

      // Normaliza estado en la columna D y marca como notificado para evitar re-envíos cada 30s
      await updateCell(`D${i + 1}`, "APROBADO").catch((err) => {
        console.error("❌ monitorAprobados (update D):", err);
      });

      await updateCell(`H${i + 1}`, "NOTIFIED_APROBADO").catch((err) => {
        console.error("❌ monitorAprobados (update H):", err);
      });
    }
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

async function telegramSendPhotoBuffer(chat_id, buffer, caption = "") {
  if (!TELEGRAM_BOT_TOKEN || !chat_id) return;

  const form = new FormData();
  form.append("chat_id", String(chat_id));
  if (caption) form.append("caption", caption);
  form.append("photo", buffer, { filename: "comprobante.jpg" });

  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
  });

  const data = await r.json().catch(() => ({}));
  if (!data?.ok) throw new Error("Telegram sendPhoto failed: " + JSON.stringify(data));
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
    console.warn("⚠️ sendConversationLog fall:", e?.message || e);
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

  // Helper: si NO ha saludado, pega saludo + respuesta en UN solo mensaje
  async function withGreeting(wa_id, replyText) {
    const greeted = await hasGreeted(wa_id);

    // Evita doble saludo si la IA ya inicia con "Hola", "👋", etc.
    const stripLeadingGreeting = (txt) => {
      let t = String(txt || "").trim();
      t = t.replace(/^([👋🙂😊😁😃😄😺]+\s*)+/u, "");
      t = t.replace(/^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)[!,.\s]*/i, "");
      return t.trim();
    };

    const cleanText = stripLeadingGreeting(replyText);

    if (!greeted) {
      await markGreeted(wa_id);
      return `👋 Bienvenido a Rifas y Sorteos El Agropecuario!\n\n${cleanText}`;
    }
    return cleanText;
  }

  // ✅ CORRECCIÓN: Declarar wa_id fuera del try para que el catch lo vea y evitar ReferenceError
  let wa_id = "";

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
          if (label === "PUBLICIDAD") return "📢 Esa imagen parece publicidad.";
          if (label === "COMPROBANTE") return "✅ Ese archivo parece un comprobante.";
          if (label === "OTRO") return "👀 Ese archivo no parece un comprobante.";
          return "👀 No logro confirmar si es comprobante. Me envías una captura más clara?";
        }
      } catch {}
    }
    return t;
  }

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    wa_id = msg.from; 
    const type = msg.type;

    // Si el cliente responde, cancelar recordatorio pendiente
    if (followUps.has(wa_id)) {
      clearTimeout(followUps.get(wa_id));
      followUps.delete(wa_id);
    }

    // Siempre tocar sesión al recibir algo (para que greeted/state no se descoordinen)
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
      "🎤 Recib tu audio, pero no pude leerlo. Intenta enviarlo otra vez."
    );

    // 🔹 LOG OUT
    await safeConversationLog("OUT", wa_id, reply);

    await sendTextM(wa_id, reply);
    return;
  }

  try {
    const text = await transcribeWhatsAppAudio(mediaId);

    // 🔹 LOG IN (texto transcrito)
    await safeConversationLog("IN", wa_id, `[audio transcrito]: ${text}`);

    const state = await getLatestStateByWaId(wa_id);
    const stage = await getConversationStage(wa_id);
    const aiReplyRaw = await askGemini(wa_id, text, state);
    const aiReply = humanizeIfJson(aiReplyRaw);

    const reply = await withGreeting(wa_id, aiReply);

    // 🔹 LOG OUT (respuesta IA)
    await safeConversationLog("OUT", wa_id, reply);

    await sendTextM(wa_id, reply);
  } catch (e) {
    console.warn("Audio transcripcin fall:", e?.message || e);

    const reply = await withGreeting(
      wa_id,
      "🎤 Recib tu audio, pero no pude entenderlo. Me lo escribes por texto, por favor?"
    );

    // 🔹 LOG OUT (error respuesta)
    await safeConversationLog("OUT", wa_id, reply);

    await sendTextM(wa_id, reply);
  }

  return;
}

 // =========
// TEXT
// =========
if (type === "text") {
  const text = (msg.text?.body || "").trim();
  const t = text.toLowerCase();

  // ✅ NUEVO: normalizador (quita tildes) para comparar sin fallar
  const tNorm = String(text)
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // 🔹 LOG IN (texto recibido)
  await safeConversationLog("IN", wa_id, text);
  console.log(`📩 Mensaje de ${wa_id}: ${text}`);

  // Guardar conversación (solo una vez por mensaje)
  await saveConversation({ wa_id, direction: "IN", message: text });

  // Estado global (Sheets) + mini-stage
  const state = await getLatestStateByWaId(wa_id);
  const stage = await getConversationStage(wa_id);

  const lastLabel = getLastImageLabel(wa_id);

  // ------------------------------------------------------------
  // 1) CONTEXTO: si venimos de una imagen clasificada como PUBLICIDAD
  // ------------------------------------------------------------
  if (lastLabel === "PUBLICIDAD") {
    // Si envía link: NO confirmamos por link. Pedimos captura/nombre del perfil.
    if (
      t.includes("http") ||
      t.includes("facebook.com") ||
      t.includes("instagram.com") ||
      t.includes("tiktok.com")
    ) {
      const reply = await withGreeting(
        wa_id,
        "Gracias por el enlace.\n\nPara confirmarte si es de nosotros o de un influencer, *no basta con el link*.\n\n✅ Envíame una *captura* donde se vea el *nombre de la página/perfil* que publicó el anuncio (arriba del post) o dime el nombre del influencer."
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, reply);

      await sendTextM(wa_id, reply);

      setLastImageLabel(wa_id, null);
      return;
    }

    // Si menciona Facebook (sin link)
    if (t.includes("facebook")) {
      const reply = await withGreeting(
        wa_id,
        "📌 Si la viste en Facebook, puede ser de nuestra página o de un colaborador/influencer.\n\n✅ Para confirmarte, envíame una *captura* donde se vea el *nombre del perfil/página* que publicó el anuncio (arriba del post)."
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, reply);

      await sendTextM(wa_id, reply);

      setLastImageLabel(wa_id, null);
      return;
    }

    // Si pregunta “es de ustedes / es publicidad / si”
    if (
      t.includes("es publicidad") ||
      t.includes("si es publicidad") ||
      t.includes("es de ustedes") ||
      t.includes("de ustedes") ||
      t === "si" ||
      t === "s"
    ) {
      const reply = await withGreeting(
        wa_id,
        "✅ Lo que me enviaste es publicidad nuestra.\n\nPara mayor seguridad, verifica en nuestra página principal: https://web.facebook.com/profile.php?id=61588354538179"
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, reply);

      await sendTextM(wa_id, reply);

      setLastImageLabel(wa_id, null);
      return;
    }

    // Si no fue útil, limpiamos contexto y seguimos con IA
    setLastImageLabel(wa_id, null);
  }

  // ------------------------------------------------------------
  // 2) GUARDARRÍL: EN_REVISION siempre gana
  // ------------------------------------------------------------
  if (state === "EN_REVISION") {
    const reply = await withGreeting(
      wa_id,
      "🕒 Tu comprobante se encuentra en revisión. Te avisamos al aprobarlo y luego enviaremos tus boletas. Este proceso puede tardar hasta 2 horas en horario de atención.\n\nSi no has enviado tus datos (Nombre, Teléfono, Municipio), hazlo por favor. Si ya los enviaste, no respondas este mensaje.\n\nSi tu boleta se demora más de 5 horas, escribe y presenta tu caso al número 300 3960782."
    );

    // 🔹 LOG OUT
    await safeConversationLog("OUT", wa_id, reply);

    await sendTextM(wa_id, reply);
    return;
  }

  // ============================================================
  // ✅ NUEVO: detectar intención fuerte de compra (evita que se vaya a IA)
  // ============================================================
  const buyIntent =
    tNorm.includes("quiero") ||
    tNorm.includes("deseo") ||
    tNorm.includes("me llevo") ||
    tNorm.includes("apuntame") ||
    tNorm.includes("separam") ||
    tNorm.includes("listo") ||
    tNorm.includes("haga") ||
    tNorm.includes("hagale") ||
    tNorm.includes("de una") ||
    tNorm.includes("particip") ||
    tNorm.includes("comprar") ||
    tNorm.includes("pagar") ||
    tNorm.includes("nequi") ||
    tNorm.includes("daviplata") ||
    tNorm.includes("davi");

  // ============================================================
  // ✅ NUEVO (SIN ELIMINAR NADA): método sin cantidad → pedir cantidad
  // ============================================================
  const mentionsMethod =
    t.includes("nequi") || t.includes("daviplata") || t.includes("davi");

  // ------------------------------------------------------------
  // CAPTURA DURA DE CANTIDAD (evita loops)
  // ------------------------------------------------------------
  let qtyCandidate = tryExtractBoletasQty(text);

  // ============================================================
  // ✅ NUEVO: cantidad en letras (uno/dos/tres/…/diez) + "un par"
  // ============================================================
  if (!qtyCandidate) {
    const wordMap = {
      "una": 1,
      "uno": 1,
      "un": 1,
      "dos": 2,
      "tres": 3,
      "cuatro": 4,
      "cinco": 5,
      "seis": 6,
      "siete": 7,
      "ocho": 8,
      "nueve": 9,
      "diez": 10,
      "once": 11,
      "doce": 12,
    };

    // "un par" => 2
    if (tNorm.includes("un par")) qtyCandidate = 2;

    // "deseo uno", "quiero dos", "dos boletas", "cinco"
    if (!qtyCandidate) {
      const mWord =
        tNorm.match(/\b(una|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b(?:\s*(boletas?|boletos?))?/i);
      if (mWord) {
        const w = mWord[1].toLowerCase();
        if (wordMap[w]) qtyCandidate = wordMap[w];
      }
    }
  }

  // ============================================================
  // ✅ NUEVO (SIN ELIMINAR NADA): parche para "2 nomás / 2 no más / 2 solamente"
  // (si tu extractor no lo captura, capturamos el primer número)
  // ============================================================
  if (!qtyCandidate) {
    const m = tNorm.match(/^\s*(\d{1,4})\b/);
    if (m) qtyCandidate = parseInt(m[1], 10);
  }

  // ============================================================
  // ✅ NUEVO: Si hay intención de compra pero aún no tenemos cantidad y NO dimos precio
  // Evita el loop de "mensaje largo" y empuja a cerrar.
  // ============================================================
  if ((buyIntent || mentionsMethod) && !qtyCandidate && stage !== "PRICE_GIVEN") {
    // Si no estamos esperando cantidad, la ponemos en AWAITING_QTY
    if (stage !== "AWAITING_QTY") {
      await setConversationStage(wa_id, "AWAITING_QTY");
    }

    const reply = await withGreeting(
      wa_id,
      "✅ Perfecto. Para apartarte el número necesito la cantidad.\n\n¿Cuántas boletas quieres? (Ej: 1, 2, 5 o 10)"
    );

    await safeConversationLog("OUT", wa_id, reply);
    await sendTextM(wa_id, reply);
    return;
  }

  // Si estamos esperando cantidad, o si el texto menciona boletas + número
  if (
    qtyCandidate &&
    (stage === "AWAITING_QTY" || t.includes("boleta") || t.includes("boletas") || buyIntent)
  ) {
    const qty = qtyCandidate;

    // Si SOLO maneja 1/2/5/10, entonces hacemos "combo" (10,5,2,1)
    const breakdown = calcTotalCOPForBoletas(qty);

    if (!breakdown) {
      const replyErr = await withGreeting(
        wa_id,
        "No entendí la cantidad. Envíame solo el número de boletas (ej: 1, 2, 5, 7, 10)."
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, replyErr);

      await sendTextM(wa_id, replyErr);
      return;
    }

    await setConversationStage(wa_id, "PRICE_GIVEN");

    // ✅ Guardar el último cálculo para usarlo cuando el usuario diga "nequi" o "daviplata"
    lastPriceQuote.set(wa_id, breakdown);

    const reply = await withGreeting(
      wa_id,
      pricingReplyMessage(qty, breakdown)
    );

    // 🔹 LOG OUT
    await safeConversationLog("OUT", wa_id, reply);

    await sendTextM(wa_id, reply);
    return;
  }

  // ✅ Si ya dimos precio y el usuario eligió método, respondemos método sin volver a preguntar cantidad
  if (stage === "PRICE_GIVEN") {
    const tt = t.toLowerCase();

    if (tt.includes("nequi") || tt.includes("daviplata") || tt.includes("davi")) {
      const quote = lastPriceQuote.get(wa_id);

      // (opcional) si no hay quote, igual respondemos método sin inventar total
      const resumen = quote?.total
        ? `✅ Para ${quote.qty} boleta(s), el total es $${formatCOP(quote.total)} COP.\n\n`
        : "";

      if (tt.includes("nequi")) {
        const reply = await withGreeting(
          wa_id,
          `${resumen}📲 Paga por *Nequi* al número *3223146142*.\nLuego envíame el comprobante + tu nombre completo + municipio + celular.`
        );

        // 🔹 LOG OUT
        await safeConversationLog("OUT", wa_id, reply);

        await sendTextM(wa_id, reply);
        return;
      }

      // daviplata
      const reply = await withGreeting(
        wa_id,
        `${resumen}📲 Paga por *Daviplata* al número *3223146142*.\nLuego envíame el comprobante + tu nombre completo + municipio + celular.`
      );

      // 🔹 LOG OUT
      await safeConversationLog("OUT", wa_id, reply);

      await sendTextM(wa_id, reply);
      return;
    }

    // ✅ NUEVO: si ya dimos precio y responde “sí / listo / de una”
    // empuja a elegir método (no se devuelve)
    if (tt === "si" || tt === "sí" || tt.includes("listo") || tt.includes("de una") || tt.includes("dale")) {
      const reply = await withGreeting(
        wa_id,
        "✅ Súper. ¿Pagas por *Nequi* o por *Daviplata*?"
      );
      await safeConversationLog("OUT", wa_id, reply);
      await sendTextM(wa_id, reply);
      return;
    }
  }

  // ------------------------------------------------------------
  // 5) TODO LO DEMÁS: IA (tu prompt manda)
  //    Recomendado: pasar stage por SYSTEM (sin meterlo en el texto del usuario)
  // ------------------------------------------------------------
  const aiReplyRaw = await askGemini(wa_id, text, state);
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
    console.warn("⚠️ Clasificación fall, contino como DUDA:", e?.message || e);

    // 🔹 LOG OUT (solo monitoreo)
    await safeConversationLog("OUT", wa_id, `⚠️ Error clasificando imagen: ${String(e?.message || e).slice(0, 300)}`);
  }

  setLastImageLabel(wa_id, cls.label);
  console.log("🧠 Clasificación imagen:", cls);

  if (cls.label === "PUBLICIDAD") {
    const reply = await withGreeting(
      wa_id,
      "📢 Esa imagen es publicidad.\n\nsi es nuestra publicidad."
    );

    // 🔹 LOG OUT
    await safeConversationLog("OUT", wa_id, reply);

    await sendTextM(wa_id, reply);
    return;
  }

  if (cls.label !== "COMPROBANTE") {
  const reply = await withGreeting(
    wa_id,
    "👀 No logro confirmar si es un comprobante.\nPor favor envíame una captura clara del recibo de pago."
  );

  // 🔹 LOG OUT
  await safeConversationLog("OUT", wa_id, reply);

  await sendTextM(wa_id, reply);
  return;
}

// ✅ Aquí crear referencia si es comprobante
const { ref } = await createReference({
  wa_id,
  last_msg_type: "image",
  receipt_media_id: mediaId,
  receipt_is_payment: "YES",
});

// ✅ Enviar comprobante a Telegram (grupo de comprobantes)
try {
  const chatId = TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID; // ✅ ADICIÓN SEGURA
  console.log("📤 Enviando comprobante a Telegram...", { chatId, wa_id, ref, mediaId }); // ✅ ADICIÓN SEGURA

  if (!chatId) {
    console.error("❌ TELEGRAM_CHAT_ID no está configurado, no puedo enviar comprobante.");
  } else {
    const mediaUrl = await fetchWhatsAppMediaUrl(mediaId);
    const { buf } = await downloadWhatsAppMediaAsBuffer(mediaUrl);

    const caption = `🧾 NUEVO COMPROBANTE
📱 Cliente: ${wa_id}
📌 Referencia: ${ref}
✅ Revisar y aprobar.`;

    await telegramSendPhotoBuffer(chatId, buf, caption);
    console.log("✅ Comprobante enviado a Telegram", { chatId, ref }); // ✅ ADICIÓN SEGURA
  }
} catch (e) {
  console.error("❌ No pude enviar comprobante a Telegram:", e?.message || e);
}

const reply = await withGreeting(
  wa_id,
  `✅ Comprobante recibido.\n\n📌 Referencia de pago: ${ref}\n\nTu pago está en revisión.`
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
    "📄 Recib un documento. Por favor envame el comprobante como *imagen/captura* para procesarlo más rapido."
  );

  // 🔹 LOG OUT
  await safeConversationLog("OUT", wa_id, reply);

  await sendTextM(wa_id, reply);
  return;
}

// Otros tipos (sticker, video, etc.)
await safeConversationLog("IN", wa_id, `[${type}] recibido`);
await saveConversation({ wa_id, direction: "IN", message: `[${type}] recibido` });

const reply = await withGreeting(
  wa_id,
  "✅ Recibido. Por favor enviame un mensaje de texto o una imagen del comprobante para ayudarte."
);

// 🔹 LOG OUT
await safeConversationLog("OUT", wa_id, reply);

await sendTextM(wa_id, reply);
} catch (e) {
  console.error("❌ /webhook error:", e?.message || e);

  // 🔹 LOG OUT (solo monitoreo)
  await safeConversationLog("OUT", wa_id, `🚨 /webhook error: ${String(e?.message || e).slice(0, 500)}`);
}
});

// TELEGRAM WEBHOOK (SECRET OBLIGATORIO)
app.post("/telegram-webhook", async (req, res) => {
  try {
    if (!TELEGRAM_SECRET_TOKEN) {
      console.error("❌ TELEGRAM_SECRET_TOKEN no est configurado (obligatorio).");
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
      if (chat_id) await telegramSendMessage(chat_id, "⚠️ Debes enviar una *foto* de la boleta.");
      return;
    }
    if (!ref) {
      if (chat_id) await telegramSendMessage(chat_id, "⚠️ Falta la referencia en el caption. Ej: RP-240224-001");
      return;
    }

    const found = await findRowByRef(ref);
    if (!found) {
      if (chat_id) await telegramSendMessage(chat_id, `❌ No encontr® esa referencia en la hoja: ${ref}`);
      return;
    }

    if (found.state !== "APROBADO" && found.state !== "BOLETA_ENVIADA") {
      if (chat_id) await telegramSendMessage(chat_id, `⚠️ La referencia ${ref} está en estado: ${found.state}. Primero debe estar APROBADO.`);
      return;
    }

    const file_path = await telegramGetFilePath(file_id);
    const imgBuffer = await telegramDownloadFileBuffer(file_path);

    const mediaId = await whatsappUploadImageBuffer(imgBuffer, "image/jpeg");
    await sendImageByMediaId(found.wa_id, mediaId, `🎟️ Boleta enviada ✅ (${ref})`);

    if (found.state !== "BOLETA_ENVIADA") {
      await updateCell(`D${found.rowNumber}`, "BOLETA_ENVIADA");
    }

    if (chat_id) await telegramSendMessage(chat_id, `✅ Envie la boleta al cliente (${found.wa_id}) y marque BOLETA_ENVIADA. (${ref})`);
  } catch (err) {
    console.error("❌ /telegram-webhook error:", err);
  }
});

/* ================= START ================= */

setInterval(monitorAprobados, 30000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
