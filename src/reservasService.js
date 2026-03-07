const { google } = require("googleapis");

// CONFIGURACIÓN DE REGLAS DE NEGOCIO
const TIMEZONE = "America/Bogota";
const OPEN_HOUR = 8;
const OPEN_MINUTE = 30;
const CLOSE_HOUR = 20;
const CLOSE_MINUTE = 30;
const RESERVATION_DURATION_HOURS = 4;

function calcularInicioReserva() {
  const now = new Date();
  
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  });
  
  const parts = formatter.formatToParts(now);
  const getPart = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  
  const year = getPart('year');
  const month = getPart('month') - 1;
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');
  
  const currentMinutes = hour * 60 + minute;
  const openMinutes = OPEN_HOUR * 60 + OPEN_MINUTE;
  const closeMinutes = CLOSE_HOUR * 60 + CLOSE_MINUTE;

  const localNow = new Date(year, month, day, hour, minute, 0);
  const localOpen = new Date(year, month, day, OPEN_HOUR, OPEN_MINUTE, 0);
  const localClose = new Date(year, month, day, CLOSE_HOUR, CLOSE_MINUTE, 0);

  if (currentMinutes < openMinutes) {
    const diffMs = localOpen.getTime() - localNow.getTime();
    return new Date(now.getTime() + diffMs).toISOString();
  }

  if (currentMinutes >= closeMinutes) {
    const localTomorrowOpen = new Date(localOpen);
    localTomorrowOpen.setDate(localTomorrowOpen.getDate() + 1);
    const diffMs = localTomorrowOpen.getTime() - localNow.getTime();
    return new Date(now.getTime() + diffMs).toISOString();
  }

  return now.toISOString();
}

function calcularExpiracionReserva(inicioIso) {
  const inicio = new Date(inicioIso);
  return new Date(inicio.getTime() + (RESERVATION_DURATION_HOURS * 60 * 60 * 1000));
}

async function reservarBoletas(sheets, sheetId, tabName, boletas, clienteWaId) {
  if (!sheets || !boletas || boletas.length === 0) return;

  const inicioReserva = calcularInicioReserva();
  console.log(`🔒 Reservando ${boletas.length} boletas para ${clienteWaId}. Inicio conteo: ${inicioReserva}`);

  try {
    const range = `${tabName}!A:A`; 
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: range,
    });

    const rows = response.data.values || [];
    const updates = [];
    const boletasSet = new Set(boletas.map(b => String(b).trim()));

    for (let i = 0; i < rows.length; i++) {
      const numero = String(rows[i][0]).trim();
      if (boletasSet.has(numero)) {
        updates.push({
          range: `${tabName}!B${i + 1}:D${i + 1}`,
          values: [["RESERVADO", clienteWaId, inicioReserva]]
        });
      }
    }

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates
        }
      });
    }
  } catch (error) {
    console.error("❌ Error crítico reservando boletas:", error);
  }
}

async function liberarReservasExpiradas(sheets, sheetId, tabName) {
  if (!sheets) return;

  try {
    const range = `${tabName}!A:D`;
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    const rows = response.data.values || [];
    const updates = [];
    const now = new Date();

    for (let i = 1; i < rows.length; i++) {
      const estado = rows[i][1];
      const reservaTsStr = rows[i][3];

      if (estado === "RESERVADO" && reservaTsStr) {
        const expiracion = calcularExpiracionReserva(reservaTsStr);

        if (now > expiracion) {
          console.log(`♻️ Liberando boleta ${rows[i][0]} (Expiró: ${expiracion.toISOString()})`);
          updates.push({
            range: `${tabName}!B${i + 1}:D${i + 1}`,
            values: [["DISPONIBLE", "", ""]]
          });
        }
      }
    }

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: updates }
      });
      console.log(`✅ Se liberaron ${updates.length} reservas expiradas.`);
    }
  } catch (error) {
    console.error("❌ Error en proceso de liberación:", error);
  }
}

module.exports = {
  reservarBoletas,
  liberarReservasExpiradas
};