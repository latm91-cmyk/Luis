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

    liberarReservas(deps);

  }, 600000);

}


module.exports = {
  startBoletasWorker
};