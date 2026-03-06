// src/bot/currency_handlers.js
// /currency — set group currency, view rates

import db from '../db/index.js';
import { CURRENCIES, getRate, formatWithCurrency } from '../services/currency.js';
import { Markup } from 'telegraf';

function esc(t) { return String(t??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
const HTML = { parse_mode: 'HTML' };

export async function handleCurrency(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Currency settings work in group chats!'); return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  const sub  = args[0]?.toUpperCase();

  if (!sub) {
    await showCurrencyMenu(ctx); return;
  }

  if (sub === 'RATES') {
    await showRates(ctx); return;
  }

  // Set group currency
  if (CURRENCIES[sub]) {
    db.prepare('UPDATE groups SET default_currency = ? WHERE id = ?').run(sub, ctx.chat.id);
    await ctx.reply(
      `✅ Group currency set to <b>${CURRENCIES[sub]} ${sub}</b>\n\n` +
      `All new receipts will use this currency.\n` +
      `<i>Use /currency rates to see live exchange rates vs INR</i>`,
      HTML);
  } else {
    await ctx.reply(
      `Unknown currency: <b>${esc(sub)}</b>\n\nSupported: ${Object.keys(CURRENCIES).join(', ')}`,
      HTML);
  }
}

async function showCurrencyMenu(ctx) {
  const group = db.prepare('SELECT default_currency FROM groups WHERE id = ?').get(ctx.chat.id);
  const current = group?.default_currency || 'INR';

  const currencyButtons = Object.entries(CURRENCIES).map(([code, symbol]) =>
    Markup.button.callback(
      `${current === code ? '✅ ' : ''}${symbol} ${code}`,
      `set_currency:${code}`
    )
  );

  // Group into rows of 3
  const rows = [];
  for (let i = 0; i < currencyButtons.length; i += 3) {
    rows.push(currencyButtons.slice(i, i + 3));
  }

  await ctx.reply(
    `<b>💱 Currency Settings</b>\n\nCurrent: <b>${CURRENCIES[current]} ${current}</b>\n\nSelect group currency:`,
    { ...HTML, ...Markup.inlineKeyboard(rows) });
}

export async function handleSetCurrency(ctx) {
  const currency = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery(`Set to ${currency}`);

  db.prepare('UPDATE groups SET default_currency = ? WHERE id = ?').run(currency, ctx.chat.id);
  await ctx.editMessageText(
    `✅ Group currency set to <b>${CURRENCIES[currency]} ${currency}</b>\n\n` +
    `New receipts will be converted to INR for splitting.\nUse /currency rates to see live rates.`,
    HTML);
}

async function showRates(ctx) {
  const popularCurrencies = ['USD', 'EUR', 'GBP', 'AED', 'SGD', 'THB', 'MYR'];

  let text = `<b>💱 Live Exchange Rates → INR</b>\n<i>(Updated every 6 hours)</i>\n\n`;

  for (const currency of popularCurrencies) {
    try {
      const rate = await getRate(currency);
      text += `${CURRENCIES[currency]} <b>${currency}</b>: ₹${rate.toFixed(2)}\n`;
    } catch {}
  }

  text += `\n<i>Use /currency &lt;CODE&gt; to set group currency\nExample: /currency USD</i>`;
  await ctx.reply(text, HTML);
}
