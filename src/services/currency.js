// src/services/currency.js
// Live exchange rates via open.er-api.com (free, no key needed)
// Falls back to hardcoded rates if API is unavailable

import fetch from 'node-fetch';
import db from '../db/index.js';

const FALLBACK_RATES = {
  USD: 83.5, EUR: 90.2, GBP: 105.8, AED: 22.7,
  SGD: 61.9, CAD: 61.2, AUD: 54.1, JPY: 0.56,
  THB: 2.35, MYR: 17.8, IDR: 0.0053,
};

// Supported currencies with symbols
export const CURRENCIES = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£',
  AED: 'د.إ', SGD: 'S$', CAD: 'C$', AUD: 'A$',
  JPY: '¥', THB: '฿', MYR: 'RM', IDR: 'Rp',
};

// ─── Get rate: fromCurrency → INR ─────────────────────────────────────────────

export async function getRate(fromCurrency) {
  if (fromCurrency === 'INR') return 1;

  // Check cache (valid for 6 hours)
  const cached = db.prepare(`
    SELECT rate FROM exchange_rates
    WHERE base = ? AND target = 'INR'
    AND updated_at > datetime('now', '-6 hours')
  `).get(fromCurrency);

  if (cached) return cached.rate;

  // Fetch fresh rate
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${fromCurrency}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = data.rates?.INR;
    if (!rate) throw new Error('INR rate not found');

    // Cache it
    db.prepare(`
      INSERT INTO exchange_rates (base, target, rate, updated_at)
      VALUES (?, 'INR', ?, datetime('now'))
      ON CONFLICT(base, target) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at
    `).run(fromCurrency, rate);

    console.log(`[Currency] ${fromCurrency} → INR = ${rate}`);
    return rate;
  } catch (err) {
    console.warn(`[Currency] API failed, using fallback: ${err.message}`);
    return FALLBACK_RATES[fromCurrency] || 1;
  }
}

// ─── Convert any currency to INR ──────────────────────────────────────────────

export async function convertToINR(amount, fromCurrency) {
  if (fromCurrency === 'INR') return amount;
  const rate = await getRate(fromCurrency);
  return Math.round(amount * rate * 100) / 100;
}

// ─── Format money with currency symbol ───────────────────────────────────────

export function formatWithCurrency(amount, currency = 'INR') {
  const symbol = CURRENCIES[currency] || currency;
  const formatted = Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return `${symbol}${formatted}`;
}

// ─── Detect currency from text (for OCR) ─────────────────────────────────────

export function detectCurrency(text) {
  if (/\$|USD|dollar/i.test(text)) return 'USD';
  if (/€|EUR|euro/i.test(text)) return 'EUR';
  if (/£|GBP|pound/i.test(text)) return 'GBP';
  if (/AED|dirham/i.test(text)) return 'AED';
  if (/S\$|SGD/i.test(text)) return 'SGD';
  if (/¥|JPY|yen/i.test(text)) return 'JPY';
  if (/THB|baht|฿/i.test(text)) return 'THB';
  if (/MYR|ringgit|RM/i.test(text)) return 'MYR';
  return 'INR'; // default
}

// ─── Refresh all cached rates ─────────────────────────────────────────────────

export async function refreshAllRates() {
  console.log('[Currency] Refreshing all exchange rates...');
  const currencies = Object.keys(CURRENCIES).filter(c => c !== 'INR');
  for (const currency of currencies) {
    try { await getRate(currency); } catch {}
  }
  console.log('[Currency] Rates refreshed');
}
