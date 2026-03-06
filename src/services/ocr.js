// src/services/ocr.js
// Uses Google Gemini Vision to extract receipt data
// Free tier: 15 requests/min, 1500 requests/day — plenty for a group bot

import fetch from 'node-fetch';

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function extractReceiptData(imageBuffer) {
  const engine = process.env.OCR_ENGINE || 'gemini';
  console.log(`[OCR] Engine: ${engine}`);

  if (engine === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      console.error('[OCR] GEMINI_API_KEY missing in .env — get it free at https://aistudio.google.com/app/apikey');
      return getMockReceiptData();
    }
    try {
      return await geminiOCR(imageBuffer);
    } catch (err) {
      console.error('[OCR] Gemini error:', err.message);
      return getMockReceiptData();
    }
  }

  if (engine === 'mock') {
    console.log('[OCR] Mock mode');
    return getMockReceiptData();
  }

  console.log('[OCR] Unknown engine, using mock');
  return getMockReceiptData();
}

// ─── Gemini Vision OCR ────────────────────────────────────────────────────────

async function geminiOCR(imageBuffer) {
  const apiKey = process.env.GEMINI_API_KEY;
  const base64Image = imageBuffer.toString('base64');

  // Detect image type from buffer magic bytes
  const mimeType = detectMimeType(imageBuffer);

  const prompt = `You are a receipt parser. Analyze this receipt image and extract the data.

Return ONLY a valid JSON object in exactly this format, no explanation, no markdown:
{
  "merchant": "store name here",
  "total": 1006.00,
  "items": [
    { "name": "Item Name", "amount": 199.00, "isTax": false, "isDiscount": false },
    { "name": "GST 5%",    "amount": 45.00,  "isTax": true,  "isDiscount": false }
  ]
}

Rules:
- merchant: the store/restaurant name only (not address or tagline)
- total: the final payable amount (look for "Total", "Grand Total", "Amount Due", "Total Invoice Amount")
- items: each line item with its price
- mark isTax=true for GST, CGST, SGST, VAT, service charge, tax lines
- mark isDiscount=true for discount or offer lines
- do NOT include subtotals, tender amounts, or payment method lines as items
- if an item appears multiple times with same price, include each separately
- keep item names concise (max 40 characters)`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Image } },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 10240 },
        }),
      }
    );
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Gemini timed out after 30s');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API ${response.status}: ${errText}`);
  }

  const data = await response.json();

  // Extract text from Gemini response
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Empty response from Gemini');

  console.log('[OCR] Gemini raw response:', rawText);

  // Parse JSON — strip markdown fences if Gemini adds them
  const cleaned = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('[OCR] Failed to parse Gemini JSON:', cleaned);
    throw new Error('Gemini returned invalid JSON');
  }

  // Validate structure
  if (!parsed.merchant || !parsed.total || !Array.isArray(parsed.items)) {
    console.error('[OCR] Gemini response missing fields:', parsed);
    throw new Error('Gemini response missing required fields');
  }

  // Normalize — ensure amounts are numbers
  parsed.items = parsed.items.map(item => ({
    name: String(item.name || 'Item').slice(0, 40),
    amount: parseFloat(item.amount) || 0,
    isTax: Boolean(item.isTax),
    isDiscount: Boolean(item.isDiscount),
  })).filter(item => item.amount > 0);

  parsed.total = parseFloat(parsed.total) || 0;

  console.log(`[OCR] Parsed: ${parsed.merchant} | ₹${parsed.total} | ${parsed.items.length} items`);

  return {
    merchant: parsed.merchant,
    items: parsed.items,
    total: parsed.total,
    rawText: rawText,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectMimeType(buffer) {
  // Check magic bytes
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  return 'image/jpeg'; // default
}

// ─── Mock fallback ────────────────────────────────────────────────────────────

function getMockReceiptData() {
  return {
    merchant: 'Sample Restaurant',
    items: [
      { name: 'Main Course x2', amount: 480, isTax: false, isDiscount: false },
      { name: 'Drinks x3', amount: 270, isTax: false, isDiscount: false },
      { name: 'Dessert', amount: 150, isTax: false, isDiscount: false },
      { name: 'GST 5%', amount: 45, isTax: true, isDiscount: false },
    ],
    total: 945,
    rawText: '[mock — add GEMINI_API_KEY to .env for real OCR]',
  };
}
