function createMonitorAprobadosWorker({ sheetsRepository, sendText }) {
  return async function monitorAprobados() {
    if (!sheetsRepository.sheets) return;

    const rows = await sheetsRepository.getAllRowsAtoH().catch((err) => {
      console.error('❌ monitorAprobados (getAllRowsAtoH):', err);
      return [];
    });

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const wa_id = row?.[2];
      const state = row?.[3];
      const notes = row?.[7];

      if (state === 'APROBADO' && notes !== 'NOTIFIED_APROBADO') {
        await sendText(wa_id, '✅ Tu pago fue aprobado. En breve te enviamos tu boleta.').catch((err) => {
          console.error('❌ monitorAprobados (sendText):', err);
        });

        await sheetsRepository.updateCell(`D${i + 1}`, 'APROBADO').catch((err) => {
          console.error('❌ monitorAprobados (update D):', err);
        });

        await sheetsRepository.updateCell(`H${i + 1}`, 'NOTIFIED_APROBADO').catch((err) => {
          console.error('❌ monitorAprobados (update H):', err);
        });
      }
    }
  };
}

module.exports = { createMonitorAprobadosWorker };
