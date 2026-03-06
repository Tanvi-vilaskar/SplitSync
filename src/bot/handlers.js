// src/bot/handlers.js
// Uses HTML parse_mode throughout — avoids all MarkdownV2 escaping issues

import { Markup } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

import db, {
  upsertUser, upsertGroup, addGroupMember, getGroupMembers,
  createReceipt, getReceipt, updateReceiptStatus,
  createReceiptItems, getReceiptItems,
  createSplits, createSplitsAndUpdateMemory, getSplitsForReceipt, markSplitPaid,
  getSimplifiedDebts, getUserMonthlyStats, getUserCategoryBreakdown,
} from '../db/index.js';

import { extractReceiptData } from '../services/ocr.js';
import { categorizeReceipt } from '../services/categorizer.js';
import { calculateSplits, formatSplitCard, formatMoney } from '../services/splitter.js';
import { getActiveTrip } from './trip_handlers.js';
import { convertToINR, detectCurrency } from '../services/currency.js';
import { checkBudgetAlerts } from './tracker_handlers.js';
import { checkMemoryAlert } from './memory_handlers.js';
import { sendApprovalRequest, checkDuplicate } from './approval_handlers.js';

// HTML escape — safe for Telegram HTML mode
function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const HTML = { parse_mode: 'HTML' };

export function trackContext(ctx, next) {
  if (ctx.from) upsertUser(ctx.from);
  if (ctx.chat && ctx.chat.type !== 'private') {
    upsertGroup(ctx.chat);
    if (ctx.from) addGroupMember(ctx.chat.id, ctx.from.id);
  }
  return next();
}

export async function handleStart(ctx) {
  const isGroup = ctx.chat.type !== 'private';
  const name = esc(ctx.from.first_name);
  if (isGroup) {
    await ctx.reply(
      `👋 Hey <b>${name}</b>! I'm <b>QBSplit</b> — your group's bill splitting assistant.\n\n` +
      `📸 Send me a receipt photo and I'll handle the splitting.\n\n` +
      `<b>Commands:</b>\n` +
      `/split — Manually enter an amount to split\n` +
      `/balances — See who owes what in this group\n` +
      `/trip — Start a trip for group expenses\n` +
      `/recurring — Set up recurring splits\n` +
      `/help — Full command list`, HTML);
  } else {
    await ctx.reply(
      `👋 Hey <b>${name}</b>!\n\n` +
      `I work best in group chats. Add me to your group and I'll help split bills automatically.\n\n` +
      `/dashboard — Your spending dashboard\n` +
      `/mystats — Monthly spending summary\n` +
      `/mybalances — What you owe across all groups\n` +
      `/budget — Set spending limits\n` +
      `/history — Receipt history\n` +
      `/export — Export to CSV`, HTML);
  }
}

export async function handleHelp(ctx) {
  await ctx.reply(
    `<b>QBSplit Commands 🤖</b>\n\n` +
    `<b>📸 In group chats:</b>\n` +
    `Send a receipt photo — auto-scan and split\n` +
    `Send a voice note — auto-detect split\n` +
    `Type naturally — "Rahul paid 500 split with Priya"\n` +
    `/split &lt;amount&gt; — Quick manual split\n` +
    `/balances — Net debts in this group\n` +
    `/nudge — Remind everyone who owes you\n` +
    `/settle @name &lt;amount&gt; — Record cash payment\n` +
    `/trip — Trip mode (start/end/status)\n` +
    `/recurring — Recurring splits\n` +
    `/currency — Set group currency\n\n` +
    `<b>📊 Personal (private chat):</b>\n` +
    `/dashboard — Full spending dashboard\n` +
    `/mystats — Monthly summary\n` +
    `/mybalances — All pending debts\n` +
    `/budget — Set category budgets\n` +
    `/history — Receipt history\n` +
    `/export — Download CSV report`, HTML);
}

// ─── Photo Handler ────────────────────────────────────────────────────────────

export async function handlePhoto(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('📸 Please send receipt photos in your group chat so I can split the bill with your group!');
    return;
  }
  const processingMsg = await ctx.reply('📸 Scanning receipt... please wait!');
  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const fileId = photo.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const imageRes = await fetch(fileLink.href);
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

    let receiptData;
    try {
      receiptData = await extractReceiptData(imageBuffer);
    } catch (ocrErr) {
      await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, null,
        '❌ Could not read the receipt clearly. Please try a better-lit, flatter photo.');
      return;
    }

    const category = await categorizeReceipt(receiptData);
    const receiptId = uuidv4();

    // Check for active trip & detect currency
    const activeTrip = getActiveTrip(ctx.chat.id);
    const detectedCurrency = detectCurrency(receiptData.rawText || '');
    const amountINR = await convertToINR(receiptData.total, detectedCurrency);

    createReceipt({
      id: receiptId, groupId: ctx.chat.id, payerId: ctx.from.id,
      merchant: receiptData.merchant, totalAmount: receiptData.total,
      category, ocrRaw: receiptData.rawText, imageFileId: fileId,
      tripId: activeTrip?.id || null,
      currency: detectedCurrency, amountINR,
    });
    createReceiptItems(receiptId, receiptData.items);

    // Budget alert — non-blocking
    checkBudgetAlerts(ctx.telegram, ctx.from.id, category).catch(() => {});

    await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

    const items = receiptData.items.filter(i => !i.isTax && !i.isDiscount);

    // Use approval system — handles duplicate detection + voting + item claiming
    await sendApprovalRequest(ctx, receiptId, receiptData, category);
  } catch (err) {
    console.error('Photo handler error:', err);
    await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, null,
      '❌ Something went wrong. Please try again.').catch(() => {});
  }
}

// ─── Voice Handler ────────────────────────────────────────────────────────────

export async function handleVoice(ctx) {
  if (ctx.chat.type === 'private') return;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  const processingMsg = await ctx.reply('🎤 Processing voice message...');

  try {
    const fileId   = ctx.message.voice.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const audioRes = await fetch(fileLink.href);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    const base64Audio = audioBuffer.toString('base64');

    const members    = getGroupMembers(ctx.chat.id);
    const memberList = members.map(m => `${m.first_name} [id:${m.id}]`).join(', ');

    const prompt = `Transcribe this voice message and extract any bill splitting information.
Group members: ${memberList}

Return ONLY valid JSON, no explanation:
{"transcript":"what was said","isSplit":true,"amount":0,"description":"expense name","payerName":"name or null","payerId":null,"memberIds":[]}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'audio/ogg', data: base64Audio } },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
        }),
      }
    );

    const data   = await res.json();
    const raw    = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match  = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Gemini response');
    const parsed = JSON.parse(match[0]);

    await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

    if (!parsed.isSplit || !parsed.amount) {
      await ctx.reply(
        `🎤 <i>"${esc(parsed.transcript)}"</i>\n\n<i>No split detected in this voice message.</i>`,
        HTML);
      return;
    }

    const payerId      = parsed.payerId || ctx.from.id;
    const splitMembers = parsed.memberIds?.length > 0
      ? members.filter(m => parsed.memberIds.includes(m.id))
      : members;

    const receiptId = uuidv4();
    createReceipt({
      id: receiptId, groupId: ctx.chat.id, payerId,
      merchant: parsed.description || 'Voice Split',
      totalAmount: parsed.amount, category: 'Other',
      ocrRaw: parsed.transcript, imageFileId: null,
    });
    createReceiptItems(receiptId, [{
      name: parsed.description || 'Voice expense',
      amount: parsed.amount, isTax: false, isDiscount: false,
    }]);

    const share  = parsed.amount / splitMembers.length;
    const splits = splitMembers
      .filter(m => m.id !== payerId)
      .map(m => ({ receiptId, debtorId: m.id, creditorId: payerId, amount: Math.round(share * 100) / 100 }));

    createSplits(splits);
    updateReceiptStatus(receiptId, 'assigned');

    const memberMap  = Object.fromEntries(members.map(m => [m.id, m]));
    const fullSplits = getSplitsForReceipt(receiptId);

    await ctx.reply(
      `🎤 <b>Voice Split Detected!</b>\n\n` +
      `💬 <i>"${esc(parsed.transcript)}"</i>\n\n` +
      `💰 Amount: <b>${formatMoney(parsed.amount)}</b>\n` +
      `📝 For: <b>${esc(parsed.description)}</b>\n\n` +
      formatSplitCard(getReceipt(receiptId), fullSplits, memberMap),
      { ...HTML, ...buildSplitCardKeyboard(receiptId, fullSplits) }
    );

  } catch (err) {
    console.error('[Voice] Error:', err.message);
    await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, null,
      '❌ Could not process voice message. Please try again.').catch(() => {});
  }
}

// ─── Natural Language Handler ─────────────────────────────────────────────────

export async function handleNaturalLanguage(ctx) {
  const text = ctx.message?.text;
  if (!text || ctx.chat.type === 'private') return false;

  const botUsername    = ctx.botInfo?.username || 'Qsplitbot';
  const hasMention     = text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
  const hasSplitKeyword = /\b(paid|split|owe|divide|share|bill|dinner|lunch|breakfast)\b/i.test(text);

  if (!hasMention && !hasSplitKeyword) return false;

  const members = getGroupMembers(ctx.chat.id);
  if (members.length < 2) return false;

  const { parseNaturalLanguageSplit } = await import('../services/nlp.js');
  const parsed = await parseNaturalLanguageSplit(text, members);

  if (!parsed?.isSplit || !parsed.amount || !parsed.members?.length) return false;

  console.log('[NLP] Detected split:', parsed);

  const payerId = parsed.payerId
    || members.find(m => m.first_name.toLowerCase() === parsed.payer?.toLowerCase())?.id
    || ctx.from.id;

  const payer        = members.find(m => m.id === payerId) || { id: ctx.from.id, first_name: ctx.from.first_name };
  const splitMembers = parsed.members.length > 0
    ? members.filter(m => parsed.members.includes(m.id))
    : members;

  if (splitMembers.length < 2) return false;

  const receiptId = uuidv4();
  createReceipt({
    id: receiptId, groupId: ctx.chat.id, payerId: payer.id,
    merchant: parsed.description || 'Natural Language Split',
    totalAmount: parsed.amount, category: 'Other',
    ocrRaw: text, imageFileId: null,
  });
  createReceiptItems(receiptId, [{
    name: parsed.description || 'Shared expense',
    amount: parsed.amount, isTax: false, isDiscount: false,
  }]);

  const share  = parsed.amount / splitMembers.length;
  const splits = splitMembers
    .filter(m => m.id !== payer.id)
    .map(m => ({ receiptId, debtorId: m.id, creditorId: payer.id, amount: Math.round(share * 100) / 100 }));

  createSplits(splits);
  updateReceiptStatus(receiptId, 'assigned');

  const memberMap   = Object.fromEntries(members.map(m => [m.id, m]));
  const fullSplits  = getSplitsForReceipt(receiptId);
  const memberNames = splitMembers.map(m => m.first_name).join(', ');

  await ctx.reply(
    `🤖 <b>Split Detected!</b>\n\n` +
    `💬 <i>"${esc(text.slice(0, 80))}"</i>\n\n` +
    `💰 Amount: <b>${formatMoney(parsed.amount)}</b>\n` +
    `👤 Paid by: <b>${esc(payer.first_name)}</b>\n` +
    `👥 Split between: <b>${esc(memberNames)}</b>\n` +
    `💸 Each owes: <b>${formatMoney(share)}</b>\n\n` +
    formatSplitCard(getReceipt(receiptId), fullSplits, memberMap),
    { ...HTML, ...buildSplitCardKeyboard(receiptId, fullSplits) }
  );

  return true;
}

// ─── Member Picker ────────────────────────────────────────────────────────────

const memberPickerState = new Map();

export async function handleChooseMembers(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery();

  const members = getGroupMembers(ctx.chat.id);
  const receipt = getReceipt(receiptId);
  if (!receipt) return;

  if (!memberPickerState.has(receiptId)) {
    memberPickerState.set(receiptId, new Set(members.map(m => m.id)));
  }
  const selected = memberPickerState.get(receiptId);

  await ctx.editMessageText(
    `👥 <b>Who's splitting this bill?</b>\n` +
    `<i>${esc(receipt.merchant)} — ${formatMoney(receipt.total_amount)}</i>\n\n` +
    `Tap to toggle members:`,
    { parse_mode: 'HTML', reply_markup: buildMemberPickerKeyboard(receiptId, members, selected).reply_markup }
  );
}

export async function handleToggleMember(ctx) {
  const [, receiptId, memberId] = ctx.callbackQuery.data.split(':');
  await ctx.answerCbQuery();

  const members = getGroupMembers(ctx.chat.id);
  const receipt = getReceipt(receiptId);

  if (!memberPickerState.has(receiptId)) {
    memberPickerState.set(receiptId, new Set(members.map(m => m.id)));
  }
  const selected = memberPickerState.get(receiptId);
  const id       = parseInt(memberId);

  if (id === receipt.payer_id) {
    await ctx.answerCbQuery('Payer must be included!', { show_alert: true }); return;
  }

  if (selected.has(id)) selected.delete(id);
  else selected.add(id);

  await ctx.editMessageReplyMarkup(
    buildMemberPickerKeyboard(receiptId, members, selected).reply_markup
  );
}

export async function handleConfirmMembers(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery('Splitting...');

  const receipt        = getReceipt(receiptId);
  const members        = getGroupMembers(ctx.chat.id);
  const selected       = memberPickerState.get(receiptId) || new Set(members.map(m => m.id));
  const selectedMembers = members.filter(m => selected.has(m.id));

  if (selectedMembers.length < 2) {
    await ctx.answerCbQuery('Select at least 2 members!', { show_alert: true }); return;
  }

  const items      = getReceiptItems(receiptId).map(item => ({ ...item, assignedTo: [] }));
  const splits     = calculateSplits(receipt, items, receipt.payer_id, selectedMembers.map(m => m.id));
  createSplitsAndUpdateMemory(splits);
  updateReceiptStatus(receiptId, 'assigned');
  memberPickerState.delete(receiptId);
  // Memory alert check (non-blocking)
  for (const s of splits) {
    checkMemoryAlert(ctx.telegram, ctx.chat.id, s.debtorId, s.creditorId).catch(() => {});
  }

  const memberMap  = Object.fromEntries(members.map(m => [m.id, m]));
  const fullSplits = getSplitsForReceipt(receiptId);
  const cardText   = formatSplitCard(receipt, fullSplits, memberMap);

  const msg = await ctx.editMessageText(cardText, {
    parse_mode: 'HTML',
    reply_markup: buildSplitCardKeyboard(receiptId, fullSplits).reply_markup,
  });
  updateReceiptStatus(receiptId, 'assigned', msg?.message_id);
}

function buildMemberPickerKeyboard(receiptId, members, selected) {
  return Markup.inlineKeyboard([
    ...members.map(m => [
      Markup.button.callback(
        `${selected.has(m.id) ? '✅' : '☐'} ${m.first_name}`,
        `toggle_member:${receiptId}:${m.id}`
      ),
    ]),
    [Markup.button.callback('✅ Confirm Split', `confirm_members:${receiptId}`)],
    [Markup.button.callback('⚡ Split All Equally', `split_equal:${receiptId}`)],
  ]);
}

// ─── Split Equal ──────────────────────────────────────────────────────────────

export async function handleSplitEqual(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery('Splitting equally...');

  const receipt = getReceipt(receiptId);
  if (!receipt) { await ctx.answerCbQuery('Receipt not found'); return; }

  const members = getGroupMembers(ctx.chat.id);
  if (members.length < 2) {
    await ctx.answerCbQuery('Need at least 2 members in the group', { show_alert: true }); return;
  }

  const items      = getReceiptItems(receiptId).map(item => ({ ...item, assignedTo: [] }));
  const splits     = calculateSplits(receipt, items, receipt.payer_id, members.map(m => m.id));
  createSplitsAndUpdateMemory(splits);
  updateReceiptStatus(receiptId, 'assigned');
  for (const s of splits) {
    checkMemoryAlert(ctx.telegram, ctx.chat.id, s.debtorId, s.creditorId).catch(() => {});
  }

  const memberMap  = Object.fromEntries(members.map(m => [m.id, m]));
  const fullSplits = getSplitsForReceipt(receiptId);
  const cardText   = formatSplitCard(receipt, fullSplits, memberMap);

  const msg = await ctx.editMessageText(cardText, {
    parse_mode: 'HTML',
    reply_markup: buildSplitCardKeyboard(receiptId, fullSplits).reply_markup,
  });
  updateReceiptStatus(receiptId, 'assigned', msg?.message_id);
}

// ─── Pay ──────────────────────────────────────────────────────────────────────

export async function handlePayCallback(ctx) {
  const [, receiptId] = ctx.callbackQuery.data.split(':');
  await ctx.answerCbQuery();

  const receipt = getReceipt(receiptId);
  if (!receipt) { await ctx.answerCbQuery('Receipt not found'); return; }

  const splits  = getSplitsForReceipt(receiptId);
  const myDebt  = splits.find(s => s.debtor_id === ctx.from.id && s.status === 'pending');
  if (!myDebt) { await ctx.answerCbQuery("✅ You're all settled!", { show_alert: true }); return; }

  // Get creditor's UPI ID from DB
  const creditor = db.prepare('SELECT * FROM users WHERE id = ?').get(myDebt.creditor_id);
  const upiId    = creditor?.upi_id;
  const amount   = Math.round(myDebt.amount * 100) / 100;
  const note     = encodeURIComponent(`QBSplit-${receipt.merchant}`);
  const name     = encodeURIComponent(creditor?.first_name || 'Friend');

  if (upiId) {
    // Send UPI deep link — opens GPay/PhonePe/Paytm directly
    const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${name}&am=${amount}&cu=INR&tn=${note}`;
    const gpayLink  = `https://gpay.app.goo.gl/pay?pa=${encodeURIComponent(upiId)}&pn=${name}&am=${amount}&tn=${note}`;

    await ctx.reply(
      `💳 <b>Pay ₹${amount} to ${esc(creditor.first_name)}</b>\n\n` +
      `🏦 UPI ID: <code>${esc(upiId)}</code>\n` +
      `💰 Amount: <b>₹${amount}</b>\n` +
      `📝 Note: QBSplit - ${esc(receipt.merchant)}\n\n` +
      `<i>Tap your preferred app to pay:</i>`,
      {
        ...HTML,
        ...Markup.inlineKeyboard([
          [Markup.button.url('💚 Pay via UPI', upiLink)],
          [Markup.button.callback('✅ I have paid', `confirm_paid:${receiptId}`)],
        ])
      }
    );
  } else {
    // No UPI ID set — show account details + mark paid button
    await ctx.reply(
      `💳 <b>Pay ₹${amount} to ${esc(creditor?.first_name || 'your friend')}</b>\n\n` +
      `⚠️ No UPI ID set for ${esc(creditor?.first_name || 'this user')}\n\n` +
      `Ask them to set it with: /myupi &lt;upi_id&gt;\n` +
      `Example: /myupi snehal@paytm\n\n` +
      `<i>After paying cash, tap below:</i>`,
      {
        ...HTML,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Mark as Paid (Cash)', `confirm_paid:${receiptId}`)],
        ])
      }
    );
  }
}

export async function handleConfirmPaid(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery('✅ Marked as paid!');
  markSplitPaid(receiptId, ctx.from.id);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await refreshSplitCard(ctx, receiptId);
  await ctx.reply(`💚 <b>${esc(ctx.from.first_name)}</b>'s share is settled!`, HTML);
}

// ─── Cancel Receipt ───────────────────────────────────────────────────────────

export async function handleCancelReceipt(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  updateReceiptStatus(receiptId, 'cancelled');
  await ctx.editMessageText('❌ Receipt cancelled.');
  await ctx.answerCbQuery('Cancelled');
}

// ─── Successful Payment ───────────────────────────────────────────────────────

export async function handleSuccessfulPayment(ctx) {
  const payment              = ctx.message.successful_payment;
  const [receiptId, userId]  = payment.invoice_payload.split(':');
  markSplitPaid(receiptId, Number(userId), payment.telegram_payment_charge_id);
  await ctx.reply(`💚 <b>${esc(ctx.from.first_name)}</b>'s share is settled!`, HTML);
  await refreshSplitCard(ctx, receiptId);
}

// ─── Balances ────────────────────────────────────────────────────────────────

export async function handleBalances(ctx) {
  if (ctx.chat.type === 'private') { await handleMyBalances(ctx); return; }
  const debts = getSimplifiedDebts(ctx.chat.id);
  if (debts.length === 0) {
    await ctx.reply('✅ All clear! No outstanding debts in this group. 🎉'); return;
  }
  let text = `<b>⚖️ Current Balances</b>\n<i>Simplified across all receipts</i>\n\n`;
  for (const d of debts) {
    text += `• <b>${esc(d.debtorName)}</b> owes <b>${esc(d.creditorName)}</b>: <b>${formatMoney(d.amount)}</b>\n`;
  }
  await ctx.reply(text, HTML);
}

// ─── My Stats ────────────────────────────────────────────────────────────────

export async function handleMyStats(ctx) {
  const stats = getUserMonthlyStats(ctx.from.id);
  const cats  = getUserCategoryBreakdown(ctx.from.id);
  const name  = esc(ctx.from.first_name);
  const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  let text = `<b>📊 ${name}'s Stats — ${month}</b>\n\n`;
  text += `💸 Total paid: <b>${formatMoney(stats?.total_paid || 0)}</b>\n`;
  text += `📥 You're owed: <b>${formatMoney(stats?.total_receivable || 0)}</b>\n`;
  text += `📤 You owe: <b>${formatMoney(stats?.total_owed || 0)}</b>\n`;
  text += `🧾 Receipts: <b>${stats?.total_receipts || 0}</b>\n\n`;

  if (cats.length > 0) {
    text += `<b>By Category:</b>\n`;
    for (const c of cats.slice(0, 5)) {
      text += `• ${esc(c.category)}: <b>${formatMoney(c.total)}</b>\n`;
    }
  } else {
    text += `<i>No spending data yet this month.</i>`;
  }
  await ctx.reply(text, HTML);
}

// ─── My Balances ─────────────────────────────────────────────────────────────

export async function handleMyBalances(ctx) {
  const name       = esc(ctx.from.first_name);
  const userGroups = db.prepare(`
    SELECT g.* FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
  `).all(ctx.from.id);

  let text   = `<b>⚖️ ${name}'s Balances</b>\n\n`;
  let hasAny = false;

  for (const group of userGroups) {
    const debts   = getSimplifiedDebts(group.id);
    const myDebts = debts.filter(d => d.debtorId === ctx.from.id || d.creditorId === ctx.from.id);
    if (myDebts.length === 0) continue;
    hasAny = true;
    text += `<b>${esc(group.title)}</b>\n`;
    for (const d of myDebts) {
      if (d.debtorId === ctx.from.id)
        text += `  📤 You owe <b>${esc(d.creditorName)}</b>: <b>${formatMoney(d.amount)}</b>\n`;
      else
        text += `  📥 <b>${esc(d.debtorName)}</b> owes you: <b>${formatMoney(d.amount)}</b>\n`;
    }
    text += '\n';
  }

  if (!hasAny) text += `✅ No outstanding balances. You're all clear!`;
  await ctx.reply(text, HTML);
}

// ─── Manual Split ────────────────────────────────────────────────────────────

export async function handleManualSplit(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Please use /split in a group chat.'); return;
  }

  const args   = ctx.message.text.split(' ').slice(1);
  const amount = parseFloat(args[0]);

  if (!amount || isNaN(amount) || amount <= 0) {
    await ctx.reply('Usage: /split &lt;amount&gt;\nExample: /split 1200', HTML); return;
  }

  const members = getGroupMembers(ctx.chat.id);
  if (members.length < 2) {
    await ctx.reply('Need at least 2 members tracked in this group. Have everyone send a message first!'); return;
  }

  const receiptId = uuidv4();
  createReceipt({
    id: receiptId, groupId: ctx.chat.id, payerId: ctx.from.id,
    merchant: 'Manual Split', totalAmount: amount,
    category: 'Other', ocrRaw: null, imageFileId: null,
  });
  createReceiptItems(receiptId, [{ name: 'Shared expense', amount, isTax: false, isDiscount: false }]);

  await ctx.reply(
    `💰 <b>Manual Split: ${formatMoney(amount)}</b>\n\nWho's splitting this?`,
    {
      ...HTML,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('⚡ Split All Equally', `split_equal:${receiptId}`),
          Markup.button.callback('👥 Choose Members',   `choose_members:${receiptId}`),
        ],
        [Markup.button.callback('❌ Cancel', `cancel_receipt:${receiptId}`)],
      ]),
    }
  );
}

// ─── Split Card Keyboard ──────────────────────────────────────────────────────

function buildSplitCardKeyboard(receiptId, splits) {
  const pending = splits.filter(s => s.status === 'pending');
  const buttons = [];
  if (pending.length > 0) {
    buttons.push([Markup.button.callback('💳 Pay My Share', `pay:${receiptId}`)]);
  }
  buttons.push([Markup.button.callback('🔄 Refresh', `refresh:${receiptId}`)]);
  return Markup.inlineKeyboard(buttons);
}

// ─── Refresh Split Card ───────────────────────────────────────────────────────

async function refreshSplitCard(ctx, receiptId) {
  const receipt   = getReceipt(receiptId);
  const members   = getGroupMembers(ctx.chat.id);
  const memberMap = Object.fromEntries(members.map(m => [m.id, m]));
  const splits    = getSplitsForReceipt(receiptId);
  const cardText  = formatSplitCard(receipt, splits, memberMap);

  try {
    if (receipt.split_message_id) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, receipt.split_message_id, null, cardText, {
          parse_mode:   'HTML',
          reply_markup: buildSplitCardKeyboard(receiptId, splits).reply_markup,
        }
      ).catch(err => {
        if (err.message?.includes('message is not modified')) return;
        throw err;
      });
    }
  } catch {
    await ctx.reply(cardText, { parse_mode: 'HTML', ...buildSplitCardKeyboard(receiptId, splits) });
  }
}

export async function handleMyUpi(ctx) {
  const args  = ctx.message.text.split(' ').slice(1);
  const upiId = args[0]?.trim();

  if (!upiId) {
    const user = db.prepare('SELECT upi_id FROM users WHERE id = ?').get(ctx.from.id);
    if (user?.upi_id) {
      await ctx.reply(`💳 Your UPI ID: <code>${esc(user.upi_id)}</code>\n\nUpdate: /myupi &lt;new_upi_id&gt;`, HTML);
    } else {
      await ctx.reply(`Set your UPI ID so friends can pay you directly!\n\n/myupi snehal@paytm\n/myupi 9876543210@ybl\n/myupi snehal@okicici`, HTML);
    }
    return;
  }

  // Basic UPI ID validation
  if (!upiId.includes('@')) {
    await ctx.reply('❌ Invalid UPI ID. It should contain @\nExample: snehal@paytm or 9876543210@ybl', HTML);
    return;
  }

  db.prepare('UPDATE users SET upi_id = ? WHERE id = ?').run(upiId, ctx.from.id);
  await ctx.reply(`✅ UPI ID saved: <code>${esc(upiId)}</code>\n\nNow when friends tap Pay, they'll see your UPI link! 💸`, HTML);
}

export async function handleRefresh(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery('Refreshed!');
  await refreshSplitCard(ctx, receiptId);
}
