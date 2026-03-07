const { VERIFY_TOKEN, META_APP_SECRET } = require('../config');
const { verifyMetaSignature } = require('../security/verifyMetaSignature');

function registerWhatsAppRoutes(app, { conversationService }) {
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
  });

  app.post('/webhook', async (req, res) => {
    if (!verifyMetaSignature(req, META_APP_SECRET)) return res.sendStatus(403);
    res.sendStatus(200);

    try {
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return;
      await conversationService.processIncomingWhatsAppMessage(msg);
    } catch (e) {
      console.error('❌ /webhook error:', e?.message || e);
    }
  });
}

module.exports = { registerWhatsAppRoutes };
