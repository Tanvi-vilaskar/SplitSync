// src/services/categorizer.js
// Uses Claude to categorize receipts based on merchant name + items

import fetch from 'node-fetch';

const CATEGORIES = [
  'Food & Drinks',
  'Transport',
  'Entertainment',
  'Shopping',
  'Travel',
  'Utilities',
  'Healthcare',
  'Other',
];

export async function categorizeReceipt({ merchant, items }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Fast rule-based fallback (works without API key)
  const ruleBasedResult = ruleBased(merchant, items);

  if (!apiKey) return ruleBasedResult;

  try {
    const itemNames = items.filter(i => !i.isTax).map(i => i.name).slice(0, 10).join(', ');
    const prompt = `Categorize this receipt into exactly one category.

Merchant: ${merchant}
Items: ${itemNames}

Categories: ${CATEGORIES.join(' | ')}

Reply with ONLY the category name, nothing else.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Fast + cheap for classification
        max_tokens: 20,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) return ruleBasedResult;

    const data = await response.json();
    const category = data.content?.[0]?.text?.trim();

    if (CATEGORIES.includes(category)) return category;
    return ruleBasedResult;

  } catch (err) {
    console.warn('Categorization API failed, using rule-based:', err.message);
    return ruleBasedResult;
  }
}

// ─── Rule-based fallback ──────────────────────────────────────────────────────

function ruleBased(merchant = '', items = []) {
  const text = `${merchant} ${items.map(i => i.name).join(' ')}`.toLowerCase();

  if (/restaurant|cafe|coffee|pizza|burger|food|kitchen|diner|bistro|dhaba|swiggy|zomato|barbeque|bbq|sushi|chinese|indian|thai/.test(text))
    return 'Food & Drinks';
  if (/uber|ola|taxi|cab|metro|bus|train|flight|petrol|fuel|parking|rapido|auto/.test(text))
    return 'Transport';
  if (/movie|cinema|concert|netflix|spotify|game|sport|pvr|inox|bowling|theatre/.test(text))
    return 'Entertainment';
  if (/amazon|flipkart|myntra|mall|store|shop|mart|supermarket|grocery|reliance|dmart/.test(text))
    return 'Shopping';
  if (/hotel|resort|airbnb|oyo|booking|flight|holiday|tour|trip/.test(text))
    return 'Travel';
  if (/electricity|water|gas|internet|mobile|recharge|bill|utility/.test(text))
    return 'Utilities';
  if (/hospital|clinic|pharmacy|medical|doctor|medicine|health/.test(text))
    return 'Healthcare';

  return 'Other';
}
