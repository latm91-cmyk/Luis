const express = require('express');

const { createSheetsClient } = require('./clients/sheetsClient');
const { createSheetsRepository } = require('./repositories/sheetsRepository');
const { createWhatsAppClient } = require('./clients/whatsappClient');
const telegramClient = require('./clients/telegramClient');
const { geminiGenerateContent } = require('./clients/geminiClient');
const { downloadWhatsAppMediaAsBuffer } = require('./media/mediaDownloader');
const { createMediaClassifier } = require('./media/mediaClassifier');
const memoryStore = require('./memory/sessionStore');
const { createConversationService } = require('./services/conversationService');
const { registerWhatsAppRoutes } = require('./controllers/whatsappController');
const { registerTelegramRoutes } = require('./controllers/telegramController');
const { createMonitorAprobadosWorker } = require('./workers/monitorAprobados');
const { startBoletasWorker } = require('./workers/boletasWorker');
const boletasService = require('./services/boletasService');

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get('/', (req, res) => res.send('OK ✅'));

const sheets = createSheetsClient();
const sheetsRepository = createSheetsRepository({ sheets });
const whatsappClient = createWhatsAppClient({ saveConversation: sheetsRepository.saveConversation });
const mediaDownloader = { downloadWhatsAppMediaAsBuffer };
const mediaClassifier = createMediaClassifier({
  geminiGenerateContent,
  fetchWhatsAppMediaUrl: whatsappClient.fetchWhatsAppMediaUrl,
  downloadWhatsAppMediaAsBuffer,
});

const conversationService = createConversationService({
  sheetsRepository,
  whatsappClient,
  telegramClient,
  mediaClassifier,
  mediaDownloader,
  memoryStore,
  geminiGenerateContent,
});

registerWhatsAppRoutes(app, { conversationService });
registerTelegramRoutes(app, { sheetsRepository, whatsappClient, telegramClient });

const monitorAprobados = createMonitorAprobadosWorker({ sheetsRepository, sendText: whatsappClient.sendText });

function start() {

  setInterval(monitorAprobados, 30000);

  startBoletasWorker({
    sheetsRepository,
    whatsappClient
  });

  const PORT = process.env.PORT || 10000;

  app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  });

}

if (require.main === module) {
  start();
}

module.exports = { app, start };
