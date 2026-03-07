const crypto = require("crypto");

function todayYYMMDD() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function formatCOP(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString("es-CO");
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

function verifyMetaSignature(req) {
  const META_APP_SECRET = process.env.META_APP_SECRET;
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

module.exports = {
  todayYYMMDD,
  formatCOP,
  isBuyIntent,
  isThanks,
  isAdQuestion,
  verifyMetaSignature
};