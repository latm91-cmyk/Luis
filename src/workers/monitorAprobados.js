function createMonitorAprobadosWorker({
  sheetsRepository,
  boletasService,
  sendText,
  sendImage
}) {

  return async function monitorAprobados() {

    if (!sheetsRepository?.sheets) return;

    const rows = await sheetsRepository.getAllRowsAtoH().catch((err) => {
      console.error("❌ monitorAprobados (getAllRowsAtoH):", err);
      return [];
    });

    for (let i = 1; i < rows.length; i++) {

      const row = rows[i];

      const wa_id = row?.[2];
      const state = row?.[3];
      const notes = row?.[7];

      if (!wa_id) continue;

      if (state === "APROBADO" && notes !== "NOTIFIED_APROBADO") {

        try {

          // 1️⃣ buscar boletas reservadas del cliente
          const reservadas = await boletasService.getBoletasReservadasCliente(
            sheetsRepository,
            wa_id
          );

          if (!reservadas.length) {
            console.log("⚠️ No hay boletas reservadas para", wa_id);
            continue;
          }

          for (const boleta of reservadas) {

            // 2️⃣ marcar como vendida
            await boletasService.confirmarVenta(
              sheetsRepository,
              boleta.boleta,
              wa_id
            );

            // 3️⃣ enviar foto de la boleta si existe
            if (boleta.ref) {

              await sendImage(
                wa_id,
                boleta.ref,
                `🎟️ Tu boleta es: ${boleta.boleta}\n\n¡Mucha suerte! 🍀`
              );

            } else {

              await sendText(
                wa_id,
                `🎟️ Tu boleta es: ${boleta.boleta}\n\n¡Mucha suerte! 🍀`
              );

            }

          }

          // 4️⃣ marcar fila como notificada
          await sheetsRepository.updateCell(
            `H${i + 1}`,
            "NOTIFIED_APROBADO"
          );

        } catch (err) {

          console.error("❌ monitorAprobados:", err);

        }

      }

    }

  };

}

module.exports = { createMonitorAprobadosWorker };
