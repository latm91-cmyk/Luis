const { SHEET_ID, CASES_TAB, CONV_TAB, SESSIONS_TAB } = require('../config');

function todayYYMMDD() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function createSheetsRepository({ sheets }) {
  async function getAllSessionsRowsAtoF() {
    if (!sheets) return [];
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SESSIONS_TAB}!A:F` });
    return res.data.values || [];
  }

  async function getSessionByWaId(wa_id) {
    const rows = await getAllSessionsRowsAtoF();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (String(row?.[1] || '').trim() === String(wa_id || '').trim()) {
        return {
          rowNumber: i + 1,
          created_at: row?.[0] || '',
          wa_id: row?.[1] || '',
          greeted: String(row?.[2] || '').toUpperCase() === 'TRUE',
          greeted_at: row?.[3] || '',
          last_seen: row?.[4] || '',
          notes: row?.[5] || '',
        };
      }
    }
    return null;
  }

  async function upsertSession({ wa_id, greeted = false, notes = '' }) {
    if (!sheets) return;

    const now = new Date().toISOString();
    const existing = await getSessionByWaId(wa_id);

    if (!existing) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SESSIONS_TAB}!A:F`,
        valueInputOption: 'RAW',
        requestBody: { values: [[now, String(wa_id), greeted ? 'TRUE' : 'FALSE', greeted ? now : '', now, notes || '']] },
      });
      return;
    }

    const rowNum = existing.rowNumber;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SESSIONS_TAB}!E${rowNum}:F${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[now, notes || existing.notes || '']] },
    });

    if (greeted && !existing.greeted) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SESSIONS_TAB}!C${rowNum}:D${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['TRUE', now]] },
      });
    }
  }

  async function hasGreeted(wa_id) {
    const s = await getSessionByWaId(wa_id);
    return !!s?.greeted;
  }

  async function markGreeted(wa_id) {
    await upsertSession({ wa_id, greeted: true });
  }

  async function touchSession(wa_id) {
    await upsertSession({ wa_id, greeted: false });
  }

  async function setConversationStage(wa_id, stage) {
    const s = await getSessionByWaId(wa_id);
    const greeted = s?.greeted || false;
    await upsertSession({ wa_id, greeted, notes: stage });
  }

  async function getConversationStage(wa_id) {
    const s = await getSessionByWaId(wa_id);
    return s?.notes || '';
  }

  async function saveConversation({ wa_id, direction, message, ref_id = '' }) {
    if (!sheets) return;
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${CONV_TAB}!A:E`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[new Date().toISOString(), wa_id, direction, message, ref_id]] },
      });
    } catch (e) {
      console.warn('⚠️ saveConversation fall:', e?.message || e);
    }
  }

  async function getAllRowsAtoH() {
    if (!sheets) return [];
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CASES_TAB}!A:H` });
    return res.data.values || [];
  }

  async function getLatestStateByWaId(wa_id) {
    const rows = await getAllRowsAtoH();
    let lastState = 'BOT';
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row?.[2] === wa_id && row?.[3]) lastState = row[3];
    }
    return lastState;
  }

  async function getLastRefNumberForToday() {
    const rows = await getAllRowsAtoH();
    const prefix = `RP-${todayYYMMDD()}-`;
    let max = 0;
    for (let i = 1; i < rows.length; i++) {
      const id = rows[i]?.[1] || '';
      if (id.startsWith(prefix)) {
        const n = parseInt(id.replace(prefix, ''), 10);
        if (!Number.isNaN(n)) max = Math.max(max, n);
      }
    }
    return max;
  }

  async function createReference({ wa_id, last_msg_type, receipt_media_id, receipt_is_payment }) {
    if (!sheets) {
      const ref = `RP-${todayYYMMDD()}-000`;
      return { ref, state: 'EN_REVISION' };
    }

    const max = await getLastRefNumberForToday();
    const next = String(max + 1).padStart(3, '0');
    const ref = `RP-${todayYYMMDD()}-${next}`;
    const created_at = new Date().toISOString();
    const state = 'EN_REVISION';

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${CASES_TAB}!A:H`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[created_at, ref, wa_id, state, last_msg_type, receipt_media_id || '', receipt_is_payment || 'UNKNOWN', '']],
      },
    });

    return { ref, state };
  }

  async function findRowByRef(refOrCase) {
    const rows = await getAllRowsAtoH();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if ((row?.[1] || '') === refOrCase) {
        return { rowNumber: i + 1, ref: row?.[1] || '', wa_id: row?.[2] || '', state: row?.[3] || '', notes: row?.[7] || '' };
      }
    }
    return null;
  }

  async function updateCell(rangeA1, value) {
    if (!sheets) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CASES_TAB}!${rangeA1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[value]] },
    });
  }

  return {
    sheets,
    hasGreeted,
    markGreeted,
    touchSession,
    setConversationStage,
    getConversationStage,
    saveConversation,
    getAllRowsAtoH,
    getLatestStateByWaId,
    createReference,
    findRowByRef,
    updateCell,
  };
}

async function touchSession(wa_id) {

  try {

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "sessions!A2:C"
    });

    const rows = res.data.values || [];

    const index = rows.findIndex(r => r[0] === wa_id);

    const now = new Date().toISOString();

    if (index === -1) {

      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: "sessions!A2",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[wa_id, now]]
        }
      });

    } else {

      const rowNumber = index + 2;

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `sessions!B${rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[now]]
        }
      });

    }

  } catch (err) {

    console.error("touchSession error", err);

  }

}

  return {
    sheets,
    hasGreeted,
    markGreeted,
    touchSession,
    setConversationStage,
    getConversationStage,
    saveConversation,
    getAllRowsAtoH,
    getLatestStateByWaId,
    createReference,
    findRowByRef,
    updateCell
  };

module.exports = {
  createSheetsRepository
};