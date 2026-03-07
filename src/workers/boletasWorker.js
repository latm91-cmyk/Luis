async function monitorAprobados(deps) {

  const {
    sheetsRepository,
    whatsappClient,
    boletasService
  } = deps;

  try {

    const pagos = await sheetsRepository.getPagosPendientes();

    for (const pago of pagos) {

      if (pago.estado !== "APROBADO") continue;

      const boletas = await boletasService.getBoletasReservadasCliente(
        sheetsRepository,
        pago.wa_id
      );

      if (!boletas.length) continue;

      for (const b of boletas) {

        await boletasService.confirmarVenta(
          sheetsRepository,
          b.boleta
        );

      }

      const numeros = boletas.map(b => b.boleta).join(", ");

      const mensaje =
        `🎉 *PAGO CONFIRMADO*\n\n` +
        `Tus boletas quedaron registradas:\n\n` +
        `🎟️ ${numeros}\n\n` +
        `¡Mucha suerte en el sorteo! 🍀`;

      await whatsappClient.sendText(
        pago.wa_id,
        mensaje
      );

      await sheetsRepository.marcarPagoProcesado(
        pago.ref
      );

    }

  } catch (err) {

    console.error("❌ Error monitorAprobados", err);

  }

}


async function liberarReservas(deps) {

  const {
    sheetsRepository,
    boletasService
  } = deps;

  try {

    const reservas = await sheetsRepository.getBoletas();

    const ahora = Date.now();

    for (const r of reservas) {

      if (r.estado !== "RESERVADA") continue;

      const fecha = new Date(r.fecha).getTime();

      const horas = (ahora - fecha) / (1000 * 60 * 60);

      if (horas >= 4) {

        await boletasService.liberarBoleta(
          sheetsRepository,
          r.boleta
        );

      }

    }

  } catch (err) {

    console.error("❌ Error liberarReservas", err);

  }

}


function startBoletasWorker(deps) {

  console.log("🧠 Worker de boletas iniciado");

  setInterval(() => {

    monitorAprobados(deps);

  }, 30000);


  setInterval(() => {

    liberarReservas(deps);

  }, 600000);

}


module.exports = {
  startBoletasWorker
};