const { followUps, lastPriceQuote, setLastImageLabel, getLastImageLabel, memPush } = require("../boletas/boletasMemory");
const sheetsService = require("../sheets/sheetsService");
const boletasService = require("../boletas/boletasService");
const aiService = require("../ai/gemini");
const sender = require("./sender");
const logger = require("../utils/logger");
const reservas = require("../reservas/reservasService");

async function handleWebhook(req, res, sheets, sheetId) {
  res.sendStatus(200);

  async function withGreeting(wa_id, replyText) {
    const greeted = await sheetsService.hasGreeted(sheets, sheetId, wa_id);

    const stripLeadingGreeting = (txt) => {
      let t = String(txt || "").trim();
      t = t.replace(/^([👋🙂😊😁😃😄😺]+\s*)+/u, "");
      t = t.replace(/^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)[!,.\s]*/i, "");
      return t.trim();
    };

    const cleanText = stripLeadingGreeting(replyText);

    if (!greeted) {
      await sheetsService.markGreeted(sheets, sheetId, wa_id);
      return `👋 Bienvenido a Rifas y Sorteos El Agropecuario!\n\n${cleanText}`;
    }
    return cleanText;
  }

  let wa_id = "";

  function humanizeIfJson(text) {
    const t = String(text || "").trim();
    if (!t) return t;

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
      } catch { }
    }
    return t;
  }

  function processAiAction(text) {
    let cleanText = text;
    let action = null;
    try {
      const match = text.match(/(\{[\s\S]*?"action"\s*:\s*"reservar_boletas"[\s\S]*?\})\s*$/);
      if (match) {
        action = JSON.parse(match[1]);
        cleanText = text.replace(match[0], "").trim();
      }
    } catch (e) {
      console.error("Error parsing AI action:", e);
    }
    return { cleanText, action };
  }

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    wa_id = msg.from;
    const type = msg.type;

    if (followUps.has(wa_id)) {
      clearTimeout(followUps.get(wa_id));
      followUps.delete(wa_id);
    }

    await sheetsService.touchSession(sheets, sheetId, wa_id);

    if (type === "audio") {
      await logger.safeConversationLog("IN", wa_id, "[audio] recibido");
      await sheetsService.saveConversation(sheets, sheetId, { wa_id, direction: "IN", message: "[audio] recibido" });
      const reply = await withGreeting(wa_id, "🎤 Recibí tu audio. Por favor, escríbeme tu consulta para poder ayudarte mejor.");
      await sender.sendTextM(sheets, sheetId, wa_id, reply);
      return;
    }

    if (type === "text") {
      const text = (msg.text?.body || "").trim();
      const t = text.toLowerCase();
      const tNorm = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

      await logger.safeConversationLog("IN", wa_id, text);
      console.log(`📩 Mensaje de ${wa_id}: ${text}`);

      memPush(wa_id, "user", text);
      await sheetsService.saveConversation(sheets, sheetId, { wa_id, direction: "IN", message: text });

      const state = await sheetsService.getLatestStateByWaId(sheets, sheetId, wa_id);
      const stage = await sheetsService.getConversationStage(sheets, sheetId, wa_id);
      const lastLabel = getLastImageLabel(wa_id);

      if (state === "EN_REVISION") {
        const reply = await withGreeting(wa_id, "🕒 Tu comprobante se encuentra en revisión. Te avisamos al aprobarlo y luego enviaremos tus boletas. Este proceso puede tardar hasta 2 horas en horario de atención.\n\nSi no has enviado tus datos (Nombre, Teléfono, Municipio), hazlo por favor. Si ya los enviaste, no respondas este mensaje.\n\nSi tu boleta se demora más de 5 horas, escribe y presenta tu caso al número 300 3960782.");
        await sender.sendTextM(sheets, sheetId, wa_id, reply);
        return;
      }

      const buyIntent = tNorm.includes("quiero") || tNorm.includes("deseo") || tNorm.includes("comprar") || tNorm.includes("pagar");
      const mentionsMethod = t.includes("nequi") || t.includes("daviplata");
      let qtyCandidate = boletasService.tryExtractBoletasQty(text);

      if (!qtyCandidate) {
        const wordMap = { "una": 1, "uno": 1, "un": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10, "once": 11, "doce": 12 };
        if (tNorm.includes("un par")) qtyCandidate = 2;
        const mWord = tNorm.match(/\b(una|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/i);
        if (mWord && wordMap[mWord[1]]) qtyCandidate = wordMap[mWord[1]];
      }

      if (!qtyCandidate) {
        const m = tNorm.match(/^\s*(\d{1,4})\b/);
        if (m) qtyCandidate = parseInt(m[1], 10);
      }

      if ((buyIntent || mentionsMethod) && !qtyCandidate && stage !== "PRICE_GIVEN") {
        if (stage !== "AWAITING_QTY") {
          await sheetsService.setConversationStage(sheets, sheetId, wa_id, "AWAITING_QTY");
        }
        const reply = await withGreeting(wa_id, "✅ Perfecto. Para apartarte el número necesito la cantidad.\n\n¿Cuántas boletas quieres? (Ej: 1, 2, 5 o 10)");
        await sender.sendTextM(sheets, sheetId, wa_id, reply);
        return;
      }

      if (qtyCandidate && (stage === "AWAITING_QTY" || t.includes("boleta") || t.includes("boletas") || buyIntent)) {
        const breakdown = boletasService.calcTotalCOPForBoletas(qtyCandidate);
        if (!breakdown) {
          const replyErr = await withGreeting(wa_id, "No entendí la cantidad. Envíame solo el número de boletas (ej: 1, 2, 5, 7, 10).");
          await sender.sendTextM(sheets, sheetId, wa_id, replyErr);
          return;
        }
        await sheetsService.setConversationStage(sheets, sheetId, wa_id, "PRICE_GIVEN");
        lastPriceQuote.set(wa_id, breakdown);
        const reply = await withGreeting(wa_id, boletasService.pricingReplyMessage(qtyCandidate, breakdown));
        await sender.sendTextM(sheets, sheetId, wa_id, reply);
        return;
      }

      if (stage === "PRICE_GIVEN") {
        if (mentionsMethod) {
          const quote = lastPriceQuote.get(wa_id);
          const resumen = quote?.total ? `✅ Para ${quote.qty} boleta(s), el total es $${boletasService.formatCOP(quote.total)} COP.\n\n` : "";
          const reply = await withGreeting(wa_id, `${resumen}📲 Paga por *Nequi* o *Daviplata* al número *3223146142*.\nLuego envíame el comprobante + tu nombre completo + municipio + celular.`);
          await sender.sendTextM(sheets, sheetId, wa_id, reply);
          return;
        }
        if (t === "si" || t === "sí" || t.includes("listo") || t.includes("de una") || t.includes("dale")) {
          const reply = await withGreeting(wa_id, "✅ Súper. ¿Pagas por *Nequi* o por *Daviplata*?");
          await sender.sendTextM(sheets, sheetId, wa_id, reply);
          return;
        }
      }

      const aiReplyRaw = await aiService.askGemini(wa_id, text, state);
      const { cleanText, action } = processAiAction(aiReplyRaw);

      if (action && action.action === "reservar_boletas") {
        console.log(`🤖 ACCIÓN IA (Texto): Reservar`, action.boletas);
        const BOLETAS_TAB = process.env.GOOGLE_SHEET_BOLETAS_TAB || "boletas";
        await reservas.reservarBoletas(sheets, sheetId, BOLETAS_TAB, action.boletas, wa_id);
      }

      const aiReply = humanizeIfJson(cleanText);
      const replyAI = await withGreeting(wa_id, aiReply);
      await sender.sendText(sheets, sheetId, wa_id, replyAI);
      return;
    }

    if (type === "image") {
      const mediaId = msg.image?.id;
      await logger.safeConversationLog("IN", wa_id, `[imagen] recibida (mediaId: ${mediaId || "N/A"})`);
      await sheetsService.saveConversation(sheets, sheetId, { wa_id, direction: "IN", message: "[imagen] recibida" });

      let cls = { label: "DUDA" };
      try {
        const classificationResult = await aiService.classifyPaymentImage({ mediaId });
        const jsonMatch = classificationResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cls = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.warn("⚠️ Clasificación falló, continúa como DUDA:", e?.message || e);
      }

      setLastImageLabel(wa_id, cls.label);
      console.log("🧠 Clasificación imagen:", cls);

      if (cls.label === "COMPROBANTE") {
        const { ref } = await sheetsService.createReference(sheets, sheetId, {
          wa_id,
          last_msg_type: "image",
          receipt_media_id: mediaId,
          receipt_is_payment: "YES",
        });

        try {
          const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
          if (TELEGRAM_CHAT_ID) {
            const mediaUrl = await sender.fetchWhatsAppMediaUrl(mediaId);
            const { buf } = await sender.downloadWhatsAppMediaAsBuffer(mediaUrl);
            const caption = `🧾 NUEVO COMPROBANTE\n📱 Cliente: ${wa_id}\n📌 Referencia: ${ref}\n✅ Revisar y aprobar.`;
            await sender.telegramSendPhotoBuffer(TELEGRAM_CHAT_ID, buf, caption); // Fixed: sender has this function, not logger
            console.log("✅ Comprobante enviado a Telegram", { chatId: TELEGRAM_CHAT_ID, ref });
          }
        } catch (e) {
          console.error("❌ No pude enviar comprobante a Telegram:", e?.message || e);
        }

        const reply = await withGreeting(wa_id, `✅ Comprobante recibido.\n\n📌 Referencia de pago: ${ref}\n\nTu pago está en revisión.`);
        await sender.sendText(sheets, sheetId, wa_id, reply, ref);
      } else if (cls.label === "PUBLICIDAD") {
        const reply = await withGreeting(wa_id, "📢 Esa imagen es publicidad.\n\nSi es nuestra publicidad, ¿te interesa comprar?");
        await sender.sendTextM(sheets, sheetId, wa_id, reply);
      } else {
        const reply = await withGreeting(wa_id, "👀 No logro confirmar si es un comprobante.\nPor favor envíame una captura clara del recibo de pago.");
        await sender.sendTextM(sheets, sheetId, wa_id, reply);
      }
      return;
    }

    await logger.safeConversationLog("IN", wa_id, `[${type}] recibido`);
    await sheetsService.saveConversation(sheets, sheetId, { wa_id, direction: "IN", message: `[${type}] recibido` });
    const reply = await withGreeting(wa_id, "✅ Recibido. Por favor envíame un mensaje de texto o una imagen del comprobante para ayudarte.");
    await sender.sendTextM(sheets, sheetId, wa_id, reply);

  } catch (e) {
    console.error("❌ /webhook error:", e?.message || e);
    await logger.safeConversationLog("OUT", wa_id, `🚨 /webhook error: ${String(e?.message || e).slice(0, 500)}`);
  }
}

module.exports = { handleWebhook };