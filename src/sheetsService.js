const { todayYYMMDD } = require("../utils/helpers");

const CASES_TAB = process.env.GOOGLE_SHEET_TAB || "cases";
const CONV_TAB = process.env.GOOGLE_SHEET_CONV_TAB || "conversations";
const SESSIONS_TAB = process.env.GOOGLE_SHEET_SESS_TAB || "sessions";

async function getAllSessionsRowsAtoF(sheets, sheetId) {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SESSIONS_TAB}!A:F`,
  });
  return res.data.values || [];
}

async function getSessionByWaId(sheets, sheetId, wa_id) {
  const rows = await getAllSessionsRowsAtoF(sheets, sheetId);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row?.[1] || "").trim() === String(wa_id || "").trim()) {
      return {
        rowNumber: i + 1,
        created_at: row?.[0] || "",
        wa_id: row?.[1] || "",
        greeted: String(row?.[2] || "").toUpperCase() === "TRUE",
        greeted_at: row?.[3] || "",
        last_seen: row?.[4] || "",
        notes: row?.[5] || "",
      };
    }
  }
  return null;
}

async function upsertSession(sheets, sheetId, { wa_id, greeted = false, notes = "" }) {
  if (!sheets) return;

  const now = new Date().toISOString();
  const existing = await getSessionByWaId(sheets, sheetId, wa_id);

  if (!existing) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${SESSIONS_TAB}!A:F`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          now,
          String(wa_id),
          greeted ? "TRUE" : "FALSE",
          greeted ? now : "",
          now,
          notes || "",
        ]],
      },
    });
    return;
  }

  const rowNum = existing.rowNumber;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SESSIONS_TAB}!E${rowNum}:F${rowNum}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[now, notes || existing.notes || ""]] },
  });

  if (greeted && !existing.greeted) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SESSIONS_TAB}!C${rowNum}:D${rowNum}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["TRUE", now]] },
    });
  }
}

async function hasGreeted(sheets, sheetId, wa_id) {
  const s = await getSessionByWaId(sheets, sheetId, wa_id);
  return !!s?.greeted;
}

async function markGreeted(sheets, sheetId, wa_id) {
  await upsertSession(sheets, sheetId, { wa_id, greeted: true });
}

async function touchSession(sheets, sheetId, wa_id) {
  await upsertSession(sheets, sheetId, { wa_id, greeted: false });
}

async function setConversationStage(sheets, sheetId, wa_id, stage) {
  const s = await getSessionByWaId(sheets, sheetId, wa_id);
  const greeted = s?.greeted || false;
  await upsertSession(sheets, sheetId, { wa_id, greeted, notes: stage });
}

async function getConversationStage(sheets, sheetId, wa_id) {
  const s = await getSessionByWaId(sheets, sheetId, wa_id);
  return s?.notes || "";
}

async function saveConversation(sheets, sheetId, { wa_id, direction, message, ref_id = "" }) {
  if (!sheets) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${CONV_TAB}!A:E`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[new Date().toISOString(), wa_id, direction, message, ref_id]],
      },
    });
  } catch (e) {
    console.warn("⚠️ saveConversation fall:", e?.message || e);
  }
}

async function getAllRowsAtoH(sheets, sheetId) {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${CASES_TAB}!A:H`,
  });
  return res.data.values || [];
}

async function getLatestStateByWaId(sheets, sheetId, wa_id) {
  const rows = await getAllRowsAtoH(sheets, sheetId);
  let lastState = "BOT";
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row?.[2] === wa_id && row?.[3]) lastState = row[3];
  }
  return lastState;
}

async function getLastRefNumberForToday(sheets, sheetId) {
  const rows = await getAllRowsAtoH(sheets, sheetId);
  const prefix = `RP-${todayYYMMDD()}-`;
  let max = 0;
  for (let i = 1; i < rows.length; i++) {
    const id = rows[i]?.[1] || "";
    if (id.startsWith(prefix)) {
      const n = parseInt(id.replace(prefix, ""), 10);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    }
  }
  return max;
}

async function createReference(sheets, sheetId, { wa_id, last_msg_type, receipt_media_id, receipt_is_payment }) {
  if (!sheets) {
    const ref = `RP-${todayYYMMDD()}-000`;
    return { ref, state: "EN_REVISION" };
  }

  const max = await getLastRefNumberForToday(sheets, sheetId);
  const next = String(max + 1).padStart(3, "0");
  const ref = `RP-${todayYYMMDD()}-${next}`;

  const created_at = new Date().toISOString();
  const state = "EN_REVISION";

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CASES_TAB}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        created_at,
        ref,
        wa_id,
        state,
        last_msg_type,
        receipt_media_id || "",
        receipt_is_payment || "UNKNOWN",
        ""
      ]],
    },
  });

  return { ref, state };
}

async function findRowByRef(sheets, sheetId, refOrCase) {
  const rows = await getAllRowsAtoH(sheets, sheetId);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if ((row?.[1] || "") === refOrCase) {
      return {
        rowNumber: i + 1,
        ref: row?.[1] || "",
        wa_id: row?.[2] || "",
        state: row?.[3] || "",
        notes: row?.[7] || "",
      };
    }
  }
  return null;
}

async function updateCell(sheets, sheetId, rangeA1, value) {
  if (!sheets) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${CASES_TAB}!${rangeA1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
}

async function monitorAprobados(sheets, sheetId, sendTextCallback) {
  if (!sheets) return;

  const rows = await getAllRowsAtoH(sheets, sheetId).catch((err) => {
    console.error("❌ monitorAprobados (getAllRowsAtoH):", err);
    return [];
  });

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const wa_id = row?.[2];
    const state = row?.[3];
    const notes = row?.[7];

    if (state === "APROBADO" && notes !== "NOTIFIED_APROBADO") {
      await sendTextCallback(wa_id, "✅ Tu pago fue aprobado. En breve te enviamos tu boleta.").catch((err) => {
        console.error("❌ monitorAprobados (sendText):", err);
      });

      await updateCell(sheets, sheetId, `D${i + 1}`, "APROBADO").catch((err) => {
        console.error("❌ monitorAprobados (update D):", err);
      });

      await updateCell(sheets, sheetId, `H${i + 1}`, "NOTIFIED_APROBADO").catch((err) => {
        console.error("❌ monitorAprobados (update H):", err);
      });
    }
  }
}

module.exports = {
  getSessionByWaId,
  upsertSession,
  hasGreeted,
  markGreeted,
  touchSession,
  setConversationStage,
  getConversationStage,
  saveConversation,
  getLatestStateByWaId,
  createReference,
  findRowByRef,
  updateCell,
  monitorAprobados
};