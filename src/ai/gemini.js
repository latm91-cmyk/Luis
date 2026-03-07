const fetch = require('node-fetch');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

async function geminiGenerateContent({ model, systemInstruction = '', contents = [] }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY no configurada');
  }

  const selectedModel = String(model || '').trim() || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = { contents };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Gemini API error: ${resp.status} ${JSON.stringify(data)}`);
  }

  if (data?.promptFeedback?.blockReason) {
    throw new Error(`Gemini bloqueó el prompt: ${data.promptFeedback.blockReason}`);
  }

  const firstCandidate = data?.candidates?.[0] || {};
  const finishReason = firstCandidate?.finishReason || '';
  const joinedText =
    firstCandidate?.content?.parts
      ?.map((p) => p.text || '')
      .join('\n')
      .trim() || '';

  if (!joinedText) {
    throw new Error(`Gemini sin texto (finishReason=${finishReason || 'N/A'})`);
  }

  return joinedText;
}

module.exports = { geminiGenerateContent };
