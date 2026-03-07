const { formatCOP } = require("../utils/helpers");

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

function calcBreakdownAnyQty(qty) {
  return calcTotalCOPForBoletas(qty);
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

module.exports = {
  calcTotalCOPForBoletas,
  calcBreakdownAnyQty,
  tryExtractBoletasQty,
  isPricingIntent,
  isAlreadyPaidIntent,
  paidInstructionMessage,
  pricingReplyMessage
};