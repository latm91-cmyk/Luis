const {
  reservarBoletaSegura,
  reservarMultiplesBoletas,
  contarBoletasDisponibles
} = require('../services/boletasService');

const {
  getOpcionesBoletas,
  seleccionarBoleta,
  resetOpciones
} = require('../services/numerosService');

const { SYSTEM_PROMPT } = require('../clients/prompt');
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
    } catch { }
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

      const tNorm = String(text)
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

      const state = await sheetsRepository.getLatestStateByWaId(wa_id);
      const stage = await sheetsRepository.getConversationStage(wa_id);

      await telegramClient.safeConversationLog('IN', wa_id, text);
      await sheetsRepository.saveConversation({
        wa_id,
        direction: 'IN',
        message: text
      });

      // =============================
      // PEDIR OTROS NUMEROS
      // =============================

      const pideOtrosNumeros =
        t === "otros" ||
        t === "mas" ||
        t === "más" ||
        t.includes("otros numeros") ||
        t.includes("otros números") ||
        t.includes("más numeros") ||
        t.includes("mas números") ||
        t.includes("otros por favor")
      t.includes("mas opciones")
      t.includes("más opciones")
      t.includes("no me gustaron")
      t.includes("otra seleccion")
      t.includes("otra selección")
      t.includes("ver otros");

      if (pideOtrosNumeros) {

        const opciones = await getOpcionesBoletas({
          sheetsRepository,
          wa_id,
          count: 5
        });

        if (!opciones.length) {

          await sendTextM(
            wa_id,
            "⚠️ Ya no quedan más boletas disponibles."
          );

          return;
        }

        let mensaje = "🎟️ Estas otras boletas están disponibles:\n\n";

        opciones.forEach((b, i) => {
          mensaje += `${i + 1}️⃣ ${b.boleta}\n`;
        });

        mensaje += "\nResponde con el número de la opción que quieres.";

        await sendTextM(wa_id, mensaje);

        return;
      }

      // =============================
      // COMPRA DIRECTA DE BOLETAS
      // =============================

      let qtyDirecta = tryExtractBoletasQty(text);

      const quiereComprarDirecto =
        t.includes("dame") ||
        t.includes("quiero") ||
        t.includes("apart") ||
        t.includes("llevo") ||
        t.includes("apuntame");

      if (qtyDirecta && quiereComprarDirecto && qtyDirecta <= 20) {

        try {

          const boletas = await reservarMultiplesBoletas(
            sheetsRepository,
            qtyDirecta,
            wa_id
          );

          if (!boletas.length) {

            await sendTextM(
              wa_id,
              "⚠️ En este momento no hay suficientes boletas disponibles."
            );

            return;
          }

          let mensaje = "🎟️ Te aparté estas boletas:\n\n";

          boletas.forEach((b, i) => {
            mensaje += `${i + 1}️⃣ ${b}\n`;
          });

          mensaje +=
            `\nAhora puedes pagar:\n\n` +
            `Nequi / Daviplata\n` +
            `📲 3223146142\n\n` +
            `Envía el comprobante + nombre + municipio.`;

          await sendTextM(wa_id, mensaje);

          return;

        } catch (err) {

          console.error("Error reservando múltiples boletas", err);

          await sendTextM(
            wa_id,
            "⚠️ Ocurrió un error reservando las boletas."
          );

          return;
        }
      }

      // =============================
      // PEDIR NUMEROS DISPONIBLES
      // =============================

      const pideNumeros =
        t.includes("numeros") ||
        t.includes("números") ||
        t.includes("boletas disponibles") ||
        t.includes("ver numeros") ||
        t.includes("ver boletas") ||
        t.includes("que numeros") ||
        t.includes("qué números") ||
        t.includes("tienes numeros") ||
        t.includes("tienes números") ||
        t.includes("puedo escoger");

      if (pideNumeros) {

        const opciones = await getOpcionesBoletas({
          sheetsRepository,
          wa_id,
          count: 5
        });

        if (!opciones.length) {

          await sendTextM(
            wa_id,
            "⚠️ En este momento no hay boletas disponibles."
          );

          return;
        }

        const conteo = await contarBoletasDisponibles(sheetsRepository);

        let mensaje =
          `🎟️ Boletas disponibles: *${conteo.disponibles} / ${conteo.total}*\n\n`;

        mensaje += "Estas boletas están disponibles:\n\n";

        opciones.forEach((b, i) => {
          mensaje += `${i + 1}️⃣ ${b.boleta}\n`;
        });

        mensaje += "\nResponde con el número de la opción que quieres.";

        await sendTextM(wa_id, mensaje);

        return;
      }

      // =============================
      // SELECCIONAR BOLETA
      // =============================

      const opcion = text.match(/^[1-5]$/);

      if (opcion) {

        const index = parseInt(opcion[0]);

        const opciones = await getOpcionesBoletas({
          sheetsRepository,
          wa_id,
          count: 5
        });

        const seleccion = seleccionarBoleta(opciones, index);

        if (!seleccion) {

          await sendTextM(
            wa_id,
            "❌ Esa opción no es válida. Elige un número del 1 al 5."
          );

          return;
        }

        const ok = await reservarBoletaSegura(
          sheetsRepository.sheets,
          sheetsRepository.sheetId,
          "boletas_index",)
        }
        
        // =============================
        // PEDIR NUMEROS DISPONIBLES
        // =============================

        const pideNumeros =
          t.includes("numeros") ||
          t.includes("números") ||
          t.includes("boletas disponibles") ||
          t.includes("ver numeros") ||
          t.includes("ver boletas") ||
          t.includes("que numeros") ||
          t.includes("qué números") ||
          t.includes("tienes numeros") ||
          t.includes("tienes números") ||
          t.includes("puedo escoger");

        if (pideNumeros) {

          const opciones = await getOpcionesBoletas({
            sheetsRepository,
            wa_id,
            count: 5
          });

          if (!opciones.length) {

            await sendTextM(
              wa_id,
              "⚠️ En este momento no hay boletas disponibles."
            );

            return;
          }

          // contador de boletas
          const conteo = await contarBoletasDisponibles(sheetsRepository);

          let mensaje =
            `🎟️ *Boletas disponibles:* ${conteo.disponibles} / ${conteo.total}\n\n`;

          mensaje += "Estas boletas están disponibles:\n\n";

          opciones.forEach((b, i) => {
            mensaje += `${i + 1}️⃣ ${b.boleta}\n`;
          });

          mensaje += "\nResponde con el número de la opción que quieres.";

          await sendTextM(wa_id, mensaje);

          return;
        }

        seleccion.boleta,
          wa_id
    );

        if (!ok) {

          await sendTextM(
            wa_id,
            "⚠️ Esa boleta ya fue reservada por otro cliente. Te muestro otras."
          );

          resetOpciones(wa_id);

          const nuevas = await getOpcionesBoletas({
            sheetsRepository,
            wa_id,
            count: 5
          });

          let mensaje = "🎟️ Estas otras boletas están disponibles:\n\n";

          nuevas.forEach((b, i) => {
            mensaje += `${i + 1}️⃣ ${b.boleta}\n`;
          });

          mensaje += "\nResponde con el número de la opción que quieres.";

          await sendTextM(wa_id, mensaje);

          return;
        }

        resetOpciones(wa_id);

        const reply =
          `✅ Boleta reservada: *${seleccion.boleta}*\n\n` +
          `Ahora puedes pagar:\n\n` +
          `Nequi / Daviplata\n` +
          `📲 3223146142\n\n` +
          `Envía el comprobante + nombre + municipio.`;

        await sendTextM(wa_id, reply);

        return;
      }

      // =============================
      // RESPUESTA IA
      // =============================

      const aiReplyRaw = await askGemini(wa_id, text, state);

      const replyAI = await withGreeting(
        wa_id,
        humanizeIfJson(aiReplyRaw)
      );

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
