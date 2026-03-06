// src/bot/recurring_handlers.js
// Recurring Splits — /recurring add, list, pause, delete

import db from '../db/index.js';
import { formatMoney } from '../services/splitter.js';
import { getGroupMembers } from '../db/index.js';
import { Markup } from 'telegraf';

function esc(t) { return String(t??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
const HTML = { parse_mode: 'HTML' };

// State store for multi-step setup (in-memory, resets on restart)
const setupState = new Map();

export async function handleRecurring(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Recurring splits work in group chats only!'); return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  const sub  = args[0]?.toLowerCase();

  if (!sub || sub === 'help') {
    await ctx.reply(
      `<b>🔄 Recurring Splits</b>\n\n` +
      `/recurring add — Set up a new recurring split\n` +
      `/recurring list — See all recurring splits\n` +
      `/recurring pause &lt;id&gt; — Pause a recurring split\n` +
      `/recurring delete &lt;id&gt; — Delete a recurring split\n\n` +
      `<i>Great for rent, Netflix, electricity bills!</i>`, HTML);
    return;
  }

  if (sub === 'add')             await startRecurringSetup(ctx);
  else if (sub === 'list')       await listRecurring(ctx);
  else if (sub === 'pause')      await pauseRecurring(ctx, parseInt(args[1]));
  else if (sub === 'delete')     await deleteRecurring(ctx, parseInt(args[1]));
}

async function startRecurringSetup(ctx) {
  const members = getGroupMembers(ctx.chat.id);
  if (members.length < 2) {
    await ctx.reply('Need at least 2 group members tracked first.'); return;
  }

  setupState.set(ctx.chat.id, { step: 'name', createdBy: ctx.from.id, groupId: ctx.chat.id });

  await ctx.reply(
    `<b>🔄 New Recurring Split</b>\n\nStep 1/4: What's the name of this expense?\n\n<i>Example: Rent, Netflix, Electricity</i>`,
    HTML);
}

export async function handleRecurringSetupMessage(ctx) {
  const state = setupState.get(ctx.chat.id);
  if (!state) return false; // not in setup flow

  const text = ctx.message.text?.trim();
  if (!text || text.startsWith('/')) return false;

  if (state.step === 'name') {
    state.name = text;
    state.step = 'amount';
    setupState.set(ctx.chat.id, state);
    await ctx.reply(`<b>Step 2/4:</b> How much is the amount?\n\n<i>Example: 5000</i>`, HTML);
    return true;
  }

  if (state.step === 'amount') {
    const amount = parseFloat(text.replace(/[₹,\s]/g, ''));
    if (!amount || isNaN(amount) || amount <= 0) {
      await ctx.reply('Please enter a valid amount (numbers only).\nExample: 5000'); return true;
    }
    state.amount = amount;
    state.step = 'frequency';
    setupState.set(ctx.chat.id, state);

    await ctx.reply(`<b>Step 3/4:</b> How often?`,
      { ...HTML, ...Markup.inlineKeyboard([
        [Markup.button.callback('📅 Monthly', 'rec_freq:monthly'),
         Markup.button.callback('📅 Weekly',  'rec_freq:weekly')],
        [Markup.button.callback('📅 Daily',   'rec_freq:daily'),
         Markup.button.callback('📅 Yearly',  'rec_freq:yearly')],
      ])});
    return true;
  }

  return false;
}

export async function handleRecurringFrequency(ctx) {
  const freq = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery();

  const state = setupState.get(ctx.chat.id);
  if (!state) return;

  state.frequency = freq;
  state.step = 'members';
  setupState.set(ctx.chat.id, state);

  const members = getGroupMembers(ctx.chat.id);

  await ctx.reply(
    `<b>Step 4/4:</b> Who splits this?\n\nSelect members (tap to toggle), then tap ✅ Done:`,
    { ...HTML, ...Markup.inlineKeyboard([
      ...members.map(m => [Markup.button.callback(`☐ ${m.first_name}`, `rec_member:${m.id}`)]),
      [Markup.button.callback('✅ Confirm Split', 'rec_confirm')],
    ])});
}

export async function handleRecurringMemberToggle(ctx) {
  const memberId = parseInt(ctx.callbackQuery.data.split(':')[1]);
  await ctx.answerCbQuery();

  const state = setupState.get(ctx.chat.id);
  if (!state) return;

  if (!state.selectedMembers) state.selectedMembers = [];
  const idx = state.selectedMembers.indexOf(memberId);
  if (idx === -1) state.selectedMembers.push(memberId);
  else state.selectedMembers.splice(idx, 1);
  setupState.set(ctx.chat.id, state);

  const members = getGroupMembers(ctx.chat.id);
  await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
    ...members.map(m => {
      const selected = state.selectedMembers?.includes(m.id);
      return [Markup.button.callback(`${selected ? '✅' : '☐'} ${m.first_name}`, `rec_member:${m.id}`)];
    }),
    [Markup.button.callback('✅ Confirm Split', 'rec_confirm')],
  ]).reply_markup);
}

export async function handleRecurringConfirm(ctx) {
  await ctx.answerCbQuery();
  const state = setupState.get(ctx.chat.id);
  if (!state || !state.selectedMembers?.length) {
    await ctx.reply('Please select at least one member first.'); return;
  }

  // Calculate first run date
  const firstRun = getFirstRunDate(state.frequency);

  db.prepare(`
    INSERT INTO recurring_splits (group_id, created_by, name, amount, frequency, next_run, member_ids, payer_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    state.groupId, state.createdBy, state.name, state.amount,
    state.frequency, firstRun,
    JSON.stringify(state.selectedMembers),
    state.createdBy
  );

  setupState.delete(ctx.chat.id);

  const memberNames = state.selectedMembers
    .map(id => db.prepare('SELECT first_name FROM users WHERE id = ?').get(id)?.first_name)
    .filter(Boolean).join(', ');

  await ctx.reply(
    `✅ <b>Recurring Split Created!</b>\n\n` +
    `📋 Name: <b>${esc(state.name)}</b>\n` +
    `💰 Amount: <b>${formatMoney(state.amount)}</b>\n` +
    `🔄 Frequency: <b>${state.frequency}</b>\n` +
    `👥 Members: <b>${esc(memberNames)}</b>\n` +
    `📅 First reminder: <b>${new Date(firstRun).toLocaleDateString('en-IN')}</b>`,
    HTML);
}

async function listRecurring(ctx) {
  const items = db.prepare(`
    SELECT * FROM recurring_splits WHERE group_id = ? ORDER BY created_at DESC
  `).all(ctx.chat.id);

  if (items.length === 0) {
    await ctx.reply('No recurring splits yet.\nUse /recurring add to create one.'); return;
  }

  let text = `<b>🔄 Recurring Splits</b>\n\n`;
  for (const r of items) {
    const status = r.active ? '🟢' : '⏸️';
    const next = new Date(r.next_run).toLocaleDateString('en-IN');
    text += `${status} <b>${esc(r.name)}</b> — ${formatMoney(r.amount)} / ${r.frequency}\n`;
    text += `   Next: ${next} | ID: ${r.id}\n\n`;
  }
  text += `<i>Use /recurring pause &lt;id&gt; or /recurring delete &lt;id&gt;</i>`;

  await ctx.reply(text, HTML);
}

async function pauseRecurring(ctx, id) {
  if (!id) { await ctx.reply('Usage: /recurring pause &lt;id&gt;', HTML); return; }
  const rec = db.prepare('SELECT * FROM recurring_splits WHERE id = ? AND group_id = ?').get(id, ctx.chat.id);
  if (!rec) { await ctx.reply('Recurring split not found.'); return; }

  const newState = rec.active ? 0 : 1;
  db.prepare('UPDATE recurring_splits SET active = ? WHERE id = ?').run(newState, id);
  await ctx.reply(`${newState ? '▶️ Resumed' : '⏸️ Paused'}: <b>${esc(rec.name)}</b>`, HTML);
}

async function deleteRecurring(ctx, id) {
  if (!id) { await ctx.reply('Usage: /recurring delete &lt;id&gt;', HTML); return; }
  const rec = db.prepare('SELECT * FROM recurring_splits WHERE id = ? AND group_id = ?').get(id, ctx.chat.id);
  if (!rec) { await ctx.reply('Recurring split not found.'); return; }

  db.prepare('DELETE FROM recurring_splits WHERE id = ?').run(id);
  await ctx.reply(`🗑️ Deleted: <b>${esc(rec.name)}</b>`, HTML);
}

function getFirstRunDate(frequency) {
  const now = new Date();
  switch (frequency) {
    case 'daily':   now.setDate(now.getDate() + 1); break;
    case 'weekly':  now.setDate(now.getDate() + 7); break;
    case 'monthly': now.setMonth(now.getMonth() + 1); break;
    case 'yearly':  now.setFullYear(now.getFullYear() + 1); break;
  }
  return now.toISOString().replace('T', ' ').slice(0, 19);
}
