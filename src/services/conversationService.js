const { SYSTEM_PROMPT } = require('../ai/prompt');
const { GEMINI_API_KEY, GEMINI_MODEL_TEXT, TELEGRAM_CHAT_ID } = require('../config');

function formatCOP(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString('es-CO');
}

function calcTotalCOPForBoletas(n) {
  const P1 = 15000;
  const P2 = 25000;
  const P5 = 60000;

  const qty = Number(n);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  let remaining = Math.floor(qty);
  const packs5 = Math.floor(remaining / 5);
  remaining %= 5;
  const packs2 = Math.floor(remaining / 2);
  remaining %= 2;
  const packs1 = remaining;
  const total = packs5 * P5 + packs2 * P2 + packs1 * P1;

  return { qty, total, packs5, packs2, packs1 };
}

function tryExtractBoletasQty(text = '') {
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

  return (
    `✅ Para *${qty}* boleta(s), el total es *$${formatCOP(total)} COP*.\n` +
    `(Combo: ${parts.join(' + ')})\n` +
    'Deseas pagar por *Nequi* o *Daviplata*?'
  );
}

function humanizeIfJson(text) {
  const t = String(text || '').trim();
  if (!t) return t;

  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const obj = JSON.parse(t);
      if (obj?.label) {
        const label = String(obj.label).toUpperCase();
        if (label === 'PUBLICIDAD') return '📢 Esa imagen parece publicidad.';
        if (label === 'COMPROBANTE') return '✅ Ese archivo parece un comprobante.';
        if (label === 'OTRO') return '👀 Ese archivo no parece un comprobante.';
        return '👀 No logro confirmar si es comprobante. Me envías una captura más clara?';
      }
    } catch {}
  }
  return t;
}

function createConversationService(deps) {
  const {
    sheetsRepository,
    whatsappClient,
    telegramClient,
    mediaClassifier,
    mediaDownloader,
    memoryStore,
    geminiGenerateContent,
  } = deps;

  async function sendTextM(to, bodyText, ref_id = '') {
    const r = await whatsappClient.sendText(to, bodyText, ref_id);
    memoryStore.memPushLegacy(to, 'assistant', bodyText);
    return r;
  }

  async function askGemini(wa_id, userText, state = 'BOT') {
    if (!GEMINI_API_KEY) return 'Te gustaría participar o conocer precios de boletas?';

    const history = memoryStore.memGet(wa_id);
    const contents = history
      .map((msg) => {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const text = String(msg.content || '').trim();
        if (!text) return null;
        return { role, parts: [{ text }] };
      })
      .filter(Boolean);

    contents.push({ role: 'user', parts: [{ text: String(userText || '') }] });

    const outputRaw = await geminiGenerateContent({
      model: GEMINI_MODEL_TEXT,
      systemInstruction: `${SYSTEM_PROMPT}\n\nEstado actual del cliente: ${state}`,
      contents,
    }).catch((error) => {
      console.error('❌ Error Gemini texto:', error?.message || error);
      return 'Lo siento, estoy teniendo problemas de conexión. ¿Podrías repetirme eso?';
    });

    const output = String(outputRaw || '').trim() || 'Me repites, por favor?';
    memoryStore.memPush(wa_id, 'user', userText);
    memoryStore.memPush(wa_id, 'assistant', output);
    return output;
  }

  async function transcribeWhatsAppAudio() {
    throw new Error('transcribeWhatsAppAudio no implementada');
  }

  async function withGreeting(wa_id, replyText) {
    const greeted = await sheetsRepository.hasGreeted(wa_id);
    const stripLeadingGreeting = (txt) => {
      let t = String(txt || '').trim();
      t = t.replace(/^([👋🙂😊😁😃😄😺]+\s*)+/u, '');
      t = t.replace(/^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)[!,.\s]*/i, '');
      return t.trim();
    };

    const cleanText = stripLeadingGreeting(replyText);
    if (!greeted) {
      await sheetsRepository.markGreeted(wa_id);
      return `👋 Bienvenido a Rifas y Sorteos El Agropecuario!\n\n${cleanText}`;
    }
    return cleanText;
  }

  async function processIncomingWhatsAppMessage(msg) {
    const wa_id = msg.from;
    const type = msg.type;

    if (memoryStore.followUps.has(wa_id)) {
      clearTimeout(memoryStore.followUps.get(wa_id));
      memoryStore.followUps.delete(wa_id);
    }

    await sheetsRepository.touchSession(wa_id);

    if (type === 'audio') {
      const mediaId = msg.audio?.id;
      await telegramClient.safeConversationLog('IN', wa_id, '[audio] recibido');
      await sheetsRepository.saveConversation({ wa_id, direction: 'IN', message: '[audio] recibido' });

      if (!mediaId) {
        const reply = await withGreeting(wa_id, '🎤 Recib tu audio, pero no pude leerlo. Intenta enviarlo otra vez.');
        await telegramClient.safeConversationLog('OUT', wa_id, reply);
        await sendTextM(wa_id, reply);
        return;
      }

      try {
        const text = await transcribeWhatsAppAudio(mediaId);
        await telegramClient.safeConversationLog('IN', wa_id, `[audio transcrito]: ${text}`);
        const state = await sheetsRepository.getLatestStateByWaId(wa_id);
        const aiReplyRaw = await askGemini(wa_id, text, state);
        const reply = await withGreeting(wa_id, humanizeIfJson(aiReplyRaw));
        await telegramClient.safeConversationLog('OUT', wa_id, reply);
        await sendTextM(wa_id, reply);
      } catch (e) {
        const reply = await withGreeting(wa_id, '🎤 Recib tu audio, pero no pude entenderlo. Me lo escribes por texto, por favor?');
        await telegramClient.safeConversationLog('OUT', wa_id, reply);
        await sendTextM(wa_id, reply);
      }
      return;
    }

    if (type === 'text') {
      const text = (msg.text?.body || '').trim();
      const t = text.toLowerCase();
      const tNorm = String(text).toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      await telegramClient.safeConversationLog('IN', wa_id, text);
      await sheetsRepository.saveConversation({ wa_id, direction: 'IN', message: text });

      const state = await sheetsRepository.getLatestStateByWaId(wa_id);
      const stage = await sheetsRepository.getConversationStage(wa_id);
      const lastLabel = memoryStore.getLastImageLabel(wa_id);

      if (lastLabel === 'PUBLICIDAD' && (t.includes('http') || t.includes('facebook.com') || t.includes('instagram.com') || t.includes('tiktok.com'))) {
        const reply = await withGreeting(wa_id, 'Gracias por el enlace.\n\nPara confirmarte si es de nosotros o de un influencer, *no basta con el link*.\n\n✅ Envíame una *captura* donde se vea el *nombre de la página/perfil* que publicó el anuncio (arriba del post) o dime el nombre del influencer.');
        await telegramClient.safeConversationLog('OUT', wa_id, reply);
        await sendTextM(wa_id, reply);
        memoryStore.setLastImageLabel(wa_id, null);
        return;
      }

      const buyIntent =
        tNorm.includes('quiero') || tNorm.includes('deseo') || tNorm.includes('me llevo') || tNorm.includes('apuntame') ||
        tNorm.includes('separam') || tNorm.includes('listo') || tNorm.includes('haga') || tNorm.includes('hagale') ||
        tNorm.includes('de una') || tNorm.includes('particip') || tNorm.includes('comprar') || tNorm.includes('pagar') ||
        tNorm.includes('nequi') || tNorm.includes('daviplata') || tNorm.includes('davi');

      const mentionsMethod = t.includes('nequi') || t.includes('daviplata') || t.includes('davi');
      let qtyCandidate = tryExtractBoletasQty(text);

      if (!qtyCandidate) {
        const wordMap = { una: 1, uno: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
        if (tNorm.includes('un par')) qtyCandidate = 2;
        if (!qtyCandidate) {
          const mWord = tNorm.match(/\b(una|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b(?:\s*(boletas?|boletos?))?/i);
          if (mWord) qtyCandidate = wordMap[mWord[1].toLowerCase()] || null;
        }
      }

      if (!qtyCandidate) {
        const m = tNorm.match(/^\s*(\d{1,4})\b/);
        if (m) qtyCandidate = parseInt(m[1], 10);
      }

      if ((buyIntent || mentionsMethod) && !qtyCandidate && stage !== 'PRICE_GIVEN') {
        if (stage !== 'AWAITING_QTY') await sheetsRepository.setConversationStage(wa_id, 'AWAITING_QTY');
        const reply = await withGreeting(wa_id, '✅ Perfecto. Para apartarte el número necesito la cantidad.\n\n¿Cuántas boletas quieres? (Ej: 1, 2, 5 o 10)');
        await telegramClient.safeConversationLog('OUT', wa_id, reply);
        await sendTextM(wa_id, reply);
        return;
      }

      if (qtyCandidate && (stage === 'AWAITING_QTY' || t.includes('boleta') || t.includes('boletas') || buyIntent)) {
        const breakdown = calcTotalCOPForBoletas(qtyCandidate);
        if (!breakdown) {
          const replyErr = await withGreeting(wa_id, 'No entendí la cantidad. Envíame solo el número de boletas (ej: 1, 2, 5, 7, 10).');
          await telegramClient.safeConversationLog('OUT', wa_id, replyErr);
          await sendTextM(wa_id, replyErr);
          return;
        }

        await sheetsRepository.setConversationStage(wa_id, 'PRICE_GIVEN');
        memoryStore.lastPriceQuote.set(wa_id, breakdown);
        const reply = await withGreeting(wa_id, pricingReplyMessage(qtyCandidate, breakdown));
        await telegramClient.safeConversationLog('OUT', wa_id, reply);
        await sendTextM(wa_id, reply);
        return;
      }

      if (stage === 'PRICE_GIVEN' && (t.includes('nequi') || t.includes('daviplata') || t.includes('davi'))) {
        const quote = memoryStore.lastPriceQuote.get(wa_id);
        const resumen = quote?.total ? `✅ Para ${quote.qty} boleta(s), el total es $${formatCOP(quote.total)} COP.\n\n` : '';
        const isNequi = t.includes('nequi');
        const reply = await withGreeting(
          wa_id,
          `${resumen}📲 Paga por *${isNequi ? 'Nequi' : 'Daviplata'}* al número *3223146142*.\nLuego envíame el comprobante + tu nombre completo + municipio + celular.`,
        );
        await telegramClient.safeConversationLog('OUT', wa_id, reply);
        await sendTextM(wa_id, reply);
        return;
      }

      const aiReplyRaw = await askGemini(wa_id, text, state);
      const replyAI = await withGreeting(wa_id, humanizeIfJson(aiReplyRaw));
      await telegramClient.safeConversationLog('OUT', wa_id, replyAI);
      await whatsappClient.sendText(wa_id, replyAI);
      return;
    }

    if (type === 'image') {
      const mediaId = msg.image?.id;
      await telegramClient.safeConversationLog('IN', wa_id, `[imagen] recibida (mediaId: ${mediaId || 'N/A'})`);
      await sheetsRepository.saveConversation({ wa_id, direction: 'IN', message: '[imagen] recibida' });

      let cls = { label: 'DUDA', confidence: 0, why: 'sin IA' };
      try {
        cls = await mediaClassifier.classifyPaymentImage({ mediaId });
      } catch (e) {
        await telegramClient.safeConversationLog('OUT', wa_id, `⚠️ Error clasificando imagen: ${String(e?.message || e).slice(0, 300)}`);
      }

      memoryStore.setLastImageLabel(wa_id, cls.label);

      if (cls.label === 'PUBLICIDAD') {
        const reply = await withGreeting(wa_id, '📢 Esa imagen es publicidad.\n\nsi es nuestra publicidad.');
        await telegramClient.safeConversationLog('OUT', wa_id, reply);
        await sendTextM(wa_id, reply);
        return;
      }

      if (cls.label !== 'COMPROBANTE') {
        const reply = await withGreeting(wa_id, '👀 No logro confirmar si es un comprobante.\nPor favor envíame una captura clara del recibo de pago.');
        await telegramClient.safeConversationLog('OUT', wa_id, reply);
        await sendTextM(wa_id, reply);
        return;
      }

      const { ref } = await sheetsRepository.createReference({ wa_id, last_msg_type: 'image', receipt_media_id: mediaId, receipt_is_payment: 'YES' });

      try {
        const chatId = TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
        if (chatId) {
          const mediaUrl = await whatsappClient.fetchWhatsAppMediaUrl(mediaId);
          const { buf } = await mediaDownloader.downloadWhatsAppMediaAsBuffer(mediaUrl);
          const caption = `🧾 NUEVO COMPROBANTE\n📱 Cliente: ${wa_id}\n📌 Referencia: ${ref}\n✅ Revisar y aprobar.`;
          await telegramClient.telegramSendPhotoBuffer(chatId, buf, caption);
        }
      } catch (e) {
        console.error('❌ No pude enviar comprobante a Telegram:', e?.message || e);
      }

      const reply = await withGreeting(wa_id, `✅ Comprobante recibido.\n\n📌 Referencia de pago: ${ref}\n\nTu pago está en revisión.`);
      await telegramClient.safeConversationLog('OUT', wa_id, reply);
      await whatsappClient.sendText(wa_id, reply, ref);
      return;
    }

    if (type === 'document') {
      await telegramClient.safeConversationLog('IN', wa_id, '[document] recibido');
      await sheetsRepository.saveConversation({ wa_id, direction: 'IN', message: '[document] recibido' });
      const reply = await withGreeting(wa_id, '📄 Recib un documento. Por favor envame el comprobante como *imagen/captura* para procesarlo más rapido.');
      await telegramClient.safeConversationLog('OUT', wa_id, reply);
      await sendTextM(wa_id, reply);
      return;
    }

    await telegramClient.safeConversationLog('IN', wa_id, `[${type}] recibido`);
    await sheetsRepository.saveConversation({ wa_id, direction: 'IN', message: `[${type}] recibido` });
    const reply = await withGreeting(wa_id, '✅ Recibido. Por favor enviame un mensaje de texto o una imagen del comprobante para ayudarte.');
    await telegramClient.safeConversationLog('OUT', wa_id, reply);
    await sendTextM(wa_id, reply);
  }

  return { processIncomingWhatsAppMessage };
}

module.exports = { createConversationService };
