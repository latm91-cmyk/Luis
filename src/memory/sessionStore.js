const { MEMORY_TURNS } = require('../config');

const followUps = new Map();
const lastPriceQuote = new Map();
const memoryLegacy = new Map();
const shortMemory = new Map();
const lastImageCheck = new Map();

function memPushLegacy(wa_id, role, content) {
  if (!wa_id) return;
  const text = String(content || '').trim();
  if (!text) return;

  const arr = memoryLegacy.get(wa_id) || [];
  arr.push({ role, content: text.slice(0, 1500), ts: new Date().toISOString() });
  while (arr.length > MEMORY_TURNS) arr.shift();
  memoryLegacy.set(wa_id, arr);
}

function memPush(wa_id, role, content) {
  if (!wa_id) return;
  const arr = shortMemory.get(wa_id) || [];
  arr.push({ role, content: String(content || '').slice(0, 1500) });
  while (arr.length > 20) arr.shift();
  shortMemory.set(wa_id, arr);
}

function memGet(wa_id) {
  return shortMemory.get(wa_id) || [];
}

function setLastImageLabel(wa_id, label) {
  lastImageCheck.set(wa_id, { label, at: Date.now() });
}

function getLastImageLabel(wa_id) {
  const data = lastImageCheck.get(wa_id);
  return data ? data.label : null;
}

module.exports = {
  followUps,
  lastPriceQuote,
  memPushLegacy,
  memPush,
  memGet,
  setLastImageLabel,
  getLastImageLabel,
};
