// Control follow-up de ventas (1 solo recordatorio)
const followUps = new Map();

// Último precio calculado por usuario (para no repetir preguntas)
const lastPriceQuote = new Map(); // wa_id -> { qty, total, packs5, packs2, packs1 }

// memoria rápida por wa_id (si reinicias server se pierde)
if (!global.lastImageCheck) global.lastImageCheck = new Map();

function setLastImageLabel(wa_id, label) {
  global.lastImageCheck.set(wa_id, { label, at: Date.now() });
}

function getLastImageLabel(wa_id) {
  const data = global.lastImageCheck.get(wa_id);
  return data ? data.label : null;
}

/* ============================================================
   MEMORIA DE CONVERSACIÓN UNIFICADA (RAM)
   ============================================================ */

const MEMORY_MAX_MESSAGES = Number(process.env.MEMORY_TURNS || 12); // 12 mensajes totales (6 turnos)
const memory = new Map(); // wa_id -> [{ role:"user"|"model", content:"...", ts:"..." }]

function memPush(wa_id, role, content) {
  if (!wa_id) return;
  const text = String(content || "").trim();
  if (!text) return;

  const arr = memory.get(wa_id) || [];
  const geminiRole = (role === "assistant" || role === "model") ? "model" : "user";
  arr.push({ role: geminiRole, content: text.slice(0, 1500), ts: new Date().toISOString() });

  while (arr.length > MEMORY_MAX_MESSAGES) arr.shift();
  memory.set(wa_id, arr);
}

function memGet(wa_id) {
  return memory.get(wa_id) || [];
}

module.exports = {
  followUps,
  lastPriceQuote,
  setLastImageLabel,
  getLastImageLabel,
  memPush,
  memGet
};