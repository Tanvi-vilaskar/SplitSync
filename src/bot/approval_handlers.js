// src/bot/approval_handlers.js
// Expense Approval System + Duplicate Detection + Itemized Claiming

import { Markup } from 'telegraf';
import db from '../db/index.js';
import {
  getReceipt, getReceiptItems, updateReceiptStatus,
  createSplits, getSplitsForReceipt, getGroupMembers,
  createSplitsAndUpdateMemory,
} from '../db/index.js';
import { formatMoney, formatSplitCard, calculateSplits } from '../services/splitter.js';
import { checkMemoryAlert } from './memory_handlers.js';

function esc(t) { return String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
const HTML = { parse_mode: 'HTML' };

// ─── Pending approvals store: receiptId → { ctx, votes } ────────────────────
const pendingApprovals = new Map();
// Itemized claims store: receiptId → Map<itemIndex, Set<userId>>
const itemClaims = new Map();

// ─── Send Approval Request after OCR ─────────────────────────────────────────

export async function sendApprovalRequest(ctx, receiptId, receiptData, category) {
  const members = getGroupMembers(ctx.chat.id);
  const receipt = getReceipt(receiptId);
  const items   = receiptData.items.filter(i => !i.isTax && !i.isDiscount).slice(0, 8);

  // Check for duplicate
  const duplicate = checkDuplicate(ctx.chat.id, receiptData.merchant, receiptData.total);

  let text = '';
  if (duplicate) {
    text += `⚠️ <b>Possible Duplicate!</b>\n`;
    text += `Similar expense found: <b>${esc(duplicate.merchant)}</b> ₹${duplicate.total_amount} (${new Date(duplicate.created_at).toLocaleDateString('en-IN')})\n\n`;
  }

  text += `📋 <b>Expense Approval Request</b>\n\n`;
  text += `🏪 <b>${esc(receiptData.merchant)}</b>\n`;
  text += `💰 Total: <b>${formatMoney(receiptData.total)}</b>\n`;
  text += `🏷 Category: <b>${esc(category)}</b>\n`;
  text += `👤 Added by: <b>${esc(ctx.from.first_name)}</b>\n\n`;

  if (items.length > 0) {
    text += `<b>Items:</b>\n`;
    items.slice(0, 5).forEach(i => {
      text += `• ${esc(i.name)}: ${formatMoney(i.amount)}\n`;
    });
    if (items.length > 5) text += `<i>...and ${items.length - 5} more</i>\n`;
  }

  text += `\n<i>Members: approve to split, reject to cancel</i>`;

  // Track votes — need majority to approve (or payer alone)
  pendingApprovals.set(receiptId, {
    approvals: new Set([ctx.from.id]), // payer auto-approves
    rejections: new Set(),
    totalMembers: members.length,
    payerId: ctx.from.id,
    chatId: ctx.chat.id,
  });

  await ctx.reply(text, {
    ...HTML,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(`✅ Approve (1/${members.length})`, `approve:${receiptId}`),
        Markup.button.callback('❌ Reject', `reject_expense:${receiptId}`),
      ],
      [Markup.button.callback('⚡ Skip & Split Equally', `split_equal:${receiptId}`)],
      [Markup.button.callback('🍽 Claim My Items', `claim_items:${receiptId}`)],
    ]),
  });
}

// ─── Handle Approve ───────────────────────────────────────────────────────────

export async function handleApprove(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery('✅ Approved!');

  const state   = pendingApprovals.get(receiptId);
  if (!state) { await ctx.answerCbQuery('Expired'); return; }

  state.approvals.add(ctx.from.id);
  state.rejections.delete(ctx.from.id);

  const members  = getGroupMembers(state.chatId);
  const majority = Math.ceil(members.length / 2);
  const count    = state.approvals.size;

  if (count >= majority) {
    // Approved — proceed to split
    pendingApprovals.delete(receiptId);
    const receipt    = getReceipt(receiptId);
    const items      = (getReceiptItems(receiptId) || []).map(i => ({ ...i, assignedTo: [] }));
    const splits     = calculateSplits(receipt, items, receipt.payer_id, members.map(m => m.id));
    createSplitsAndUpdateMemory(splits);
    updateReceiptStatus(receiptId, 'assigned');

    const memberMap  = Object.fromEntries(members.map(m => [m.id, m]));
    const fullSplits = getSplitsForReceipt(receiptId);

    await ctx.editMessageText(
      `✅ <b>Expense Approved!</b> (${count}/${members.length} votes)\n\n` +
      formatSplitCard(receipt, fullSplits, memberMap),
      {
        ...HTML,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💳 Pay My Share', `pay:${receiptId}`)],
          [Markup.button.callback('🔄 Refresh', `refresh:${receiptId}`)],
        ]),
      }
    );

    for (const s of splits) {
      checkMemoryAlert(ctx.telegram, state.chatId, s.debtorId, s.creditorId).catch(() => {});
    }
  } else {
    // Update vote count
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        [
          Markup.button.callback(`✅ Approve (${count}/${members.length})`, `approve:${receiptId}`),
          Markup.button.callback('❌ Reject', `reject_expense:${receiptId}`),
        ],
        [Markup.button.callback('⚡ Skip & Split Equally', `split_equal:${receiptId}`)],
        [Markup.button.callback('🍽 Claim My Items', `claim_items:${receiptId}`)],
      ]).reply_markup
    );
  }
}

// ─── Handle Reject ────────────────────────────────────────────────────────────

export async function handleRejectExpense(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  const state     = pendingApprovals.get(receiptId);

  if (!state) { await ctx.answerCbQuery('Already processed'); return; }

  state.rejections.add(ctx.from.id);
  state.approvals.delete(ctx.from.id);

  const members  = getGroupMembers(state.chatId);
  const majority = Math.ceil(members.length / 2);

  if (state.rejections.size >= majority) {
    pendingApprovals.delete(receiptId);
    updateReceiptStatus(receiptId, 'cancelled');
    await ctx.answerCbQuery('❌ Expense rejected');
    await ctx.editMessageText(
      `❌ <b>Expense Rejected</b>\n\n${state.rejections.size}/${members.length} members rejected this expense.\nNo splits created.`,
      HTML
    );
  } else {
    await ctx.answerCbQuery('Vote recorded');
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        [
          Markup.button.callback(`✅ Approve (${state.approvals.size}/${members.length})`, `approve:${receiptId}`),
          Markup.button.callback(`❌ Reject (${state.rejections.size})`, `reject_expense:${receiptId}`),
        ],
        [Markup.button.callback('⚡ Skip & Split Equally', `split_equal:${receiptId}`)],
        [Markup.button.callback('🍽 Claim My Items', `claim_items:${receiptId}`)],
      ]).reply_markup
    );
  }
}

// ─── Itemized Item Claiming ───────────────────────────────────────────────────

export async function handleClaimItems(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery();

  const receipt = getReceipt(receiptId);
  const items   = (getReceiptItems(receiptId) || []).filter(i => !i.isTax && !i.isDiscount);

  if (items.length === 0) {
    await ctx.answerCbQuery('No items to claim!', { show_alert: true }); return;
  }

  if (!itemClaims.has(receiptId)) {
    itemClaims.set(receiptId, new Map());
  }
  const claims = itemClaims.get(receiptId);

  await ctx.reply(
    buildItemClaimText(receipt, items, claims),
    { ...HTML, ...buildItemClaimKeyboard(receiptId, items, claims, ctx.from.id) }
  );
}

export async function handleClaimItem(ctx) {
  const [, receiptId, itemIdx] = ctx.callbackQuery.data.split(':');
  await ctx.answerCbQuery('Claimed!');

  const items  = (getReceiptItems(receiptId) || []).filter(i => !i.isTax && !i.isDiscount);
  const receipt = getReceipt(receiptId);

  if (!itemClaims.has(receiptId)) itemClaims.set(receiptId, new Map());
  const claims = itemClaims.get(receiptId);
  const idx    = parseInt(itemIdx);

  if (!claims.has(idx)) claims.set(idx, new Set());
  const claimers = claims.get(idx);

  if (claimers.has(ctx.from.id)) claimers.delete(ctx.from.id);
  else claimers.add(ctx.from.id);

  await ctx.editMessageText(
    buildItemClaimText(receipt, items, claims),
    { ...HTML, ...buildItemClaimKeyboard(receiptId, items, claims, ctx.from.id) }
  );
}

export async function handleConfirmClaims(ctx) {
  const receiptId = ctx.callbackQuery.data.split(':')[1];
  await ctx.answerCbQuery('Calculating splits...');

  const receipt = getReceipt(receiptId);
  const items   = (getReceiptItems(receiptId) || []).filter(i => !i.isTax && !i.isDiscount);
  const members = getGroupMembers(receipt.group_id);
  const claims  = itemClaims.get(receiptId) || new Map();

  // Build per-person amounts based on claimed items
  const personAmounts = {};
  let unclaimed = 0;

  items.forEach((item, idx) => {
    const claimers = claims.get(idx);
    if (!claimers || claimers.size === 0) {
      unclaimed += item.amount; // split equally later
    } else {
      const share = item.amount / claimers.size;
      for (const userId of claimers) {
        personAmounts[userId] = (personAmounts[userId] || 0) + share;
      }
    }
  });

  // Split unclaimed items equally
  if (unclaimed > 0) {
    const share = unclaimed / members.length;
    for (const m of members) {
      personAmounts[m.id] = (personAmounts[m.id] || 0) + share;
    }
  }

  // Create splits
  const splits = [];
  for (const [userId, amount] of Object.entries(personAmounts)) {
    const uid = parseInt(userId);
    if (uid !== receipt.payer_id && amount > 0.01) {
      splits.push({
        receiptId,
        debtorId:   uid,
        creditorId: receipt.payer_id,
        amount:     Math.round(amount * 100) / 100,
      });
    }
  }

  if (splits.length === 0) {
    await ctx.answerCbQuery('No splits to create!', { show_alert: true }); return;
  }

  createSplitsAndUpdateMemory(splits);
  updateReceiptStatus(receiptId, 'assigned');
  itemClaims.delete(receiptId);

  const memberMap  = Object.fromEntries(members.map(m => [m.id, m]));
  const fullSplits = getSplitsForReceipt(receiptId);

  await ctx.editMessageText(
    `🍽 <b>Itemized Split Done!</b>\n\n` + formatSplitCard(receipt, fullSplits, memberMap),
    {
      ...HTML,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Pay My Share', `pay:${receiptId}`)],
        [Markup.button.callback('🔄 Refresh', `refresh:${receiptId}`)],
      ]),
    }
  );
}

function buildItemClaimText(receipt, items, claims) {
  let text = `🍽 <b>Claim Your Items</b>\n`;
  text += `<i>${esc(receipt.merchant)} — ${formatMoney(receipt.total_amount)}</i>\n\n`;
  text += `Tap items you consumed:\n\n`;

  items.forEach((item, idx) => {
    const claimers = claims.get(idx);
    const count    = claimers?.size || 0;
    const mark     = count > 0 ? `✅ (${count})` : '☐';
    text += `${mark} ${esc(item.name)} — ${formatMoney(item.amount)}\n`;
  });

  text += `\n<i>Unclaimed items split equally among all</i>`;
  return text;
}

function buildItemClaimKeyboard(receiptId, items, claims, myId) {
  const buttons = items.slice(0, 8).map((item, idx) => {
    const claimers = claims.get(idx);
    const mine     = claimers?.has(myId);
    return [Markup.button.callback(
      `${mine ? '✅' : '☐'} ${item.name.slice(0, 20)} ₹${item.amount}`,
      `claim_item:${receiptId}:${idx}`
    )];
  });
  buttons.push([Markup.button.callback('✅ Confirm Claims', `confirm_claims:${receiptId}`)]);
  buttons.push([Markup.button.callback('⚡ Split All Equally Instead', `split_equal:${receiptId}`)]);
  return Markup.inlineKeyboard(buttons);
}

// ─── Duplicate Detection ──────────────────────────────────────────────────────

export function checkDuplicate(groupId, merchant, amount) {
  return db.prepare(`
    SELECT * FROM receipts
    WHERE group_id = ?
    AND LOWER(merchant) = LOWER(?)
    AND ABS(total_amount - ?) < 1
    AND created_at > datetime('now', '-1 hour')
    AND status != 'cancelled'
    LIMIT 1
  `).get(groupId, merchant, amount);
}
