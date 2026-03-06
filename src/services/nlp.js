// src/services/nlp.js
// Natural language split parser using Gemini

import fetch from 'node-fetch';

export async function parseNaturalLanguageSplit(text, groupMembers) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const memberList = groupMembers
    .map(m => `${m.first_name}${m.username ? ' (@' + m.username + ')' : ''} [id:${m.id}]`)
    .join('\n');

  const prompt = `You are a bill-splitting assistant. Extract split info from this message.

Group members:
${memberList}

Message: ${text}

Rules:
- isSplit: true only if message is clearly about splitting a bill or expense
- payer: first name of who paid (or null if unclear)
- payerId: their id from the list (or null)
- members: array of IDs of people splitting (include payer)
- if "everyone" or "all" mentioned, include ALL member IDs
- amount: just the number, no currency symbols
- description: short name for the expense

Respond with ONLY this JSON, nothing else:
{"isSplit":false,"payer":null,"payerId":null,"amount":0,"description":"","members":[]}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 10240 },
        }),
      }
    );
    clearTimeout(timeout);

    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Safe JSON extraction
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      // Manual field extraction as last resort
      const isSplit = /\"isSplit\"\s*:\s*true/i.test(raw);
      if (!isSplit) return { isSplit: false };
      const amountMatch = raw.match(/"amount"\s*:\s*(\d+(?:\.\d+)?)/);
      const memberMatch = raw.match(/"members"\s*:\s*\[([^\]]*)\]/);
      return {
        isSplit: true,
        amount: amountMatch ? parseFloat(amountMatch[1]) : null,
        members: memberMatch
          ? memberMatch[1].split(',').map(n => parseInt(n.trim())).filter(Boolean)
          : groupMembers.map(m => m.id),
        description: 'Shared expense',
        payer: null,
        payerId: null,
      };
    }
  } catch (err) {
    console.error('[NLP] Error:', err.message);
    return null;
  }
}
