const memory = new Map();

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

async function getOpcionesBoletas({
  sheetsRepository,
  wa_id,
  count = 5
}) {

  const rows = await sheetsRepository.getBoletas();

  const disponibles = rows.filter(
    r => r.estado === "DISPONIBLE"
  );

  if (!disponibles.length) {
    return [];
  }

  const session = memory.get(wa_id) || {
    mostradas: []
  };

  const filtradas = disponibles.filter(
    b => !session.mostradas.includes(b.boleta)
  );

  const shuffled = shuffle(filtradas);

  const seleccion = shuffled.slice(0, count);

  session.mostradas.push(...seleccion.map(b => b.boleta));

  memory.set(wa_id, session);

  return seleccion;

}

function resetOpciones(wa_id) {

  memory.delete(wa_id);

}

function seleccionarBoleta(opciones, index) {

  if (!opciones || !opciones.length) return null;

  if (index < 1 || index > opciones.length) return null;

  return opciones[index - 1];

}

module.exports = {
  getOpcionesBoletas,
  seleccionarBoleta,
  resetOpciones
};