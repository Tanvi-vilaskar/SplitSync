// src/bot/leaderboard_handlers.js
// Leaderboard, Private Mode, Settle All, Emoji Commands

import { Markup } from 'telegraf';
import db from '../db/index.js';
import { formatMoney, formatSplitCard } from '../services/splitter.js';
import { getSimplifiedDebts, getGroupMembers } from '../db/index.js';

function esc(t) { return String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
const HTML = { parse_mode: 'HTML' };

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
const CATEGORY_EMOJI = {
  'Food & Drinks':'🍽','Transport':'🚗','Entertainment':'🎬',
  'Shopping':'🛍','Travel':'✈️','Utilities':'⚡','Healthcare':'🏥','Other':'📦',
};

// ─── /leaderboard ─────────────────────────────────────────────────────────────

export async function handleLeaderboard(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Leaderboard works in group chats!'); return;
  }

  const now        = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

  // Top spenders (who paid most receipts)
  const spenders = db.prepare(`
    SELECT u.first_name, u.id,
      COALESCE(SUM(r.total_amount), 0) as total,
      COUNT(r.id) as receipt_count
    FROM users u
    JOIN group_members gm ON gm.user_id = u.id AND gm.group_id = ?
    LEFT JOIN receipts r ON r.payer_id = u.id AND r.group_id = ?
      AND r.created_at >= ? AND r.status != 'cancelled'
    GROUP BY u.id ORDER BY total DESC
  `).all(ctx.chat.id, ctx.chat.id, monthStart);

  // Fastest settler
  const settlers = db.prepare(`
    SELECT u.first_name,
      AVG(CAST((julianday(s.paid_at) - julianday(r.created_at)) * 24 AS REAL)) as avg_hours
    FROM users u
    JOIN group_members gm ON gm.user_id = u.id AND gm.group_id = ?
    JOIN splits s ON s.debtor_id = u.id AND s.status = 'paid'
    JOIN receipts r ON r.id = s.receipt_id AND r.group_id = ?
    WHERE s.paid_at IS NOT NULL
    GROUP BY u.id HAVING avg_hours IS NOT NULL
    ORDER BY avg_hours ASC LIMIT 1
  `).get(ctx.chat.id, ctx.chat.id);

  // Most generous (paid for others most)
  const generous = spenders[0];

  // Ghost (oldest unpaid debt)
  const ghost = db.prepare(`
    SELECT u.first_name,
      MAX(CAST((julianday('now') - julianday(r.created_at)) AS INTEGER)) as days_old,
      SUM(s.amount) as total_owed
    FROM users u
    JOIN splits s ON s.debtor_id = u.id AND s.status = 'pending'
    JOIN receipts r ON r.id = s.receipt_id AND r.group_id = ?
    JOIN group_members gm ON gm.user_id = u.id AND gm.group_id = ?
    GROUP BY u.id ORDER BY days_old DESC LIMIT 1
  `).get(ctx.chat.id, ctx.chat.id);

  const month = now.toLocaleString('en-US', { month: 'long' });

  let text = `🏆 <b>Group Leaderboard — ${month}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Top spenders
  text += `<b>💸 Top Spenders:</b>\n`;
  spenders.filter(s => s.total > 0).slice(0, 5).forEach((s, i) => {
    text += `${MEDALS[i] || `${i+1}.`} <b>${esc(s.first_name)}</b> — ${formatMoney(s.total)} (${s.receipt_count} receipts)\n`;
  });

  if (spenders.every(s => s.total === 0)) {
    text += `<i>No spending this month yet</i>\n`;
  }

  text += '\n';

  // Special badges
  if (generous?.total > 0) {
    text += `🎖 <b>Most Generous:</b> ${esc(generous.first_name)} — always picks up the tab!\n`;
  }
  if (settlers) {
    const hrs = Math.round(settlers.avg_hours);
    text += `⚡ <b>Fastest Settler:</b> ${esc(settlers.first_name)} — pays in ${hrs < 24 ? hrs + ' hours' : Math.round(hrs/24) + ' days'} avg\n`;
  }
  if (ghost) {
    text += `👻 <b>The Ghost:</b> ${esc(ghost.first_name)} — ${formatMoney(ghost.total_owed)} pending for ${ghost.days_old} days\n`;
  }

  // Category breakdown for group
  const cats = db.prepare(`
    SELECT category, COALESCE(SUM(total_amount),0) as total
    FROM receipts WHERE group_id = ? AND created_at >= ? AND status != 'cancelled'
    GROUP BY category ORDER BY total DESC LIMIT 4
  `).all(ctx.chat.id, monthStart);

  if (cats.length > 0) {
    text += `\n<b>📦 Where You Spent:</b>\n`;
    for (const c of cats) {
      text += `${CATEGORY_EMOJI[c.category]||'📦'} ${esc(c.category)}: <b>${formatMoney(c.total)}</b>\n`;
    }
  }

  text += `\n<i>Updated live · /leaderboard to refresh</i>`;
  await ctx.reply(text, HTML);
}

// ─── /privatebalance — DM your balance privately ──────────────────────────────

export async function handlePrivateBalance(ctx) {
  const userId = ctx.from.id;

  // Find all groups this user is in
  const groups = db.prepare(`
    SELECT g.* FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
  `).all(userId);

  let hasAny   = false;
  let text     = `🔒 <b>Your Private Balance Summary</b>\n<i>Only you can see this</i>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const group of groups) {
    const debts   = getSimplifiedDebts(group.id);
    const myDebts = debts.filter(d => d.debtorId === userId || d.creditorId === userId);
    if (myDebts.length === 0) continue;

    hasAny = true;
    text += `<b>👥 ${esc(group.title)}</b>\n`;

    const iOwe   = myDebts.filter(d => d.debtorId   === userId);
    const owedMe = myDebts.filter(d => d.creditorId === userId);

    if (iOwe.length > 0) {
      text += `  📤 <b>You owe:</b>\n`;
      for (const d of iOwe) {
        text += `    • ${esc(d.creditorName)}: <b>${formatMoney(d.amount)}</b>\n`;
      }
    }
    if (owedMe.length > 0) {
      text += `  📥 <b>You're owed:</b>\n`;
      for (const d of owedMe) {
        text += `    • ${esc(d.debtorName)}: <b>${formatMoney(d.amount)}</b>\n`;
      }
    }
    text += '\n';
  }

  if (!hasAny) text += `✅ You're all clear! No pending balances anywhere.`;

  // Send as DM
  try {
    await ctx.telegram.sendMessage(userId, text, HTML);
    if (ctx.chat.type !== 'private') {
      await ctx.reply(`🔒 Balance summary sent to your DM privately!`, HTML);
    }
  } catch {
    // User hasn't started bot privately
    await ctx.reply(
      `❌ Please start a private chat with me first!\n👉 @Qsplitbot → /start\nThen use /privatebalance again.`,
      HTML
    );
  }
}

// ─── /settleall — settle all debts in group at once ──────────────────────────

export async function handleSettleAll(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Use /settleall in a group chat!'); return;
  }

  const debts = getSimplifiedDebts(ctx.chat.id);
  if (debts.length === 0) {
    await ctx.reply('✅ Nothing to settle — group is all clear!'); return;
  }

  // Only show debts involving current user
  const myDebts = debts.filter(d =>
    d.debtorId === ctx.from.id || d.creditorId === ctx.from.id
  );

  if (myDebts.length === 0) {
    await ctx.reply(`✅ <b>${esc(ctx.from.first_name)}</b> — you have no pending balances in this group!`, HTML);
    return;
  }

  let text = `💸 <b>Settle All — Final Payments</b>\n\n`;
  text += `<b>Your pending settlements:</b>\n\n`;

  const buttons = [];
  for (const d of myDebts) {
    if (d.debtorId === ctx.from.id) {
      text += `📤 You → <b>${esc(d.creditorName)}</b>: <b>${formatMoney(d.amount)}</b>\n`;
    } else {
      text += `📥 <b>${esc(d.debtorName)}</b> → You: <b>${formatMoney(d.amount)}</b>\n`;
    }
  }

  // Full group summary
  text += `\n<b>Full Group:</b>\n`;
  for (const d of debts) {
    text += `• ${esc(d.debtorName)} → ${esc(d.creditorName)}: ${formatMoney(d.amount)}\n`;
  }

  text += `\n<i>Use /settle @name amount to mark each as paid</i>`;

  await ctx.reply(text, {
    ...HTML,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Mark ALL My Debts as Settled', `settle_all_confirm:${ctx.from.id}`)],
    ]),
  });
}

export async function handleSettleAllConfirm(ctx) {
  const userId = parseInt(ctx.callbackQuery.data.split(':')[1]);
  await ctx.answerCbQuery('Settling all...');

  if (userId !== ctx.from.id) {
    await ctx.answerCbQuery('Not your button!', { show_alert: true }); return;
  }

  // Mark all splits where this user is debtor as paid in this group
  const result = db.prepare(`
    UPDATE splits SET status = 'paid', paid_at = datetime('now')
    WHERE debtor_id = ? AND status = 'pending'
    AND receipt_id IN (SELECT id FROM receipts WHERE group_id = ?)
  `).run(userId, ctx.chat.id);

  await ctx.editMessageText(
    `✅ <b>All Settled!</b>\n\n` +
    `<b>${esc(ctx.from.first_name)}</b> marked ${result.changes} split(s) as paid.\n\n` +
    `<i>Use /balances to verify</i>`,
    HTML
  );
}

// ─── Emoji Commands 🍕 💰 🚕 ──────────────────────────────────────────────────

export async function handleEmojiCommand(ctx) {
  const text = ctx.message?.text || ctx.message?.caption || '';
  if (ctx.chat.type === 'private') return false;

  // Patterns: 🍕 600 split 3  OR  🚕 250 me and Rahul  OR  💰 500
  const emojiMap = {
    '🍕':'Food & Drinks','🍔':'Food & Drinks','🍜':'Food & Drinks','🍣':'Food & Drinks',
    '🚕':'Transport','🚗':'Transport','🚌':'Transport','✈️':'Travel','🚂':'Travel',
    '🛍':'Shopping','🛒':'Shopping','🎬':'Entertainment','🎮':'Entertainment',
    '⚡':'Utilities','💡':'Utilities','🏥':'Healthcare','💊':'Healthcare',
    '🎉':'Entertainment','🍺':'Food & Drinks','☕':'Food & Drinks','🧃':'Food & Drinks',
  };

  const emoji = Object.keys(emojiMap).find(e => text.startsWith(e));
  if (!emoji) return false;

  const category = emojiMap[emoji];
  const rest     = text.slice(emoji.length).trim();

  // Extract amount
  const amountMatch = rest.match(/(\d+(?:\.\d+)?)/);
  if (!amountMatch) return false;

  const amount  = parseFloat(amountMatch[1]);
  const members = getGroupMembers(ctx.chat.id);
  if (members.length < 2) return false;

  // Check for member count hint: "split 3" or "between 2"
  const splitCount = rest.match(/split\s+(\d+)|between\s+(\d+)/i);
  const count      = splitCount ? parseInt(splitCount[1] || splitCount[2]) : members.length;
  const splitWith  = members.slice(0, Math.min(count, members.length));

  const share = amount / splitWith.length;

  await ctx.reply(
    `${emoji} <b>Quick Split!</b>\n\n` +
    `💰 Amount: <b>${formatMoney(amount)}</b>\n` +
    `🏷 Category: <b>${esc(category)}</b>\n` +
    `👥 Split ${splitWith.length} ways: <b>${formatMoney(share)} each</b>\n\n` +
    `<i>Tap to confirm:</i>`,
    {
      ...HTML,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Confirm Split', `emoji_confirm:${amount}:${ctx.from.id}`),
          Markup.button.callback('👥 Choose Members', `emoji_choose:${amount}:${category}`),
        ],
      ]),
    }
  );
  return true;
}

export async function handleEmojiConfirm(ctx) {
  const [, amount, payerId] = ctx.callbackQuery.data.split(':');
  await ctx.answerCbQuery('Creating split...');

  const { v4: uuidv4 } = await import('uuid');
  const { createReceipt, createReceiptItems } = await import('../db/index.js');

  const members   = getGroupMembers(ctx.chat.id);
  const receiptId = uuidv4();
  const amt       = parseFloat(amount);
  const pId       = parseInt(payerId);

  createReceipt({
    id: receiptId, groupId: ctx.chat.id, payerId: pId,
    merchant: 'Quick Emoji Split', totalAmount: amt,
    category: 'Other', ocrRaw: null, imageFileId: null,
  });
  createReceiptItems(receiptId, [{ name: 'Quick split', amount: amt, isTax: false, isDiscount: false }]);

  const share  = amt / members.length;
  const splits = members
    .filter(m => m.id !== pId)
    .map(m => ({ receiptId, debtorId: m.id, creditorId: pId, amount: Math.round(share*100)/100 }));

  const { createSplitsAndUpdateMemory: csm } = await import('../db/index.js');
  const { updateReceiptStatus: urs, getSplitsForReceipt: gsfr } = await import('../db/index.js');
  csm(splits);
  urs(receiptId, 'assigned');

  const memberMap  = Object.fromEntries(members.map(m => [m.id, m]));
  const { getReceipt: gr } = await import('../db/index.js');
  const fullSplits = gsfr(receiptId);

  await ctx.editMessageText(
    `✅ <b>Split Created!</b>\n\n` + formatSplitCard(gr(receiptId), fullSplits, memberMap),
    {
      ...HTML,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Pay My Share', `pay:${receiptId}`)],
        [Markup.button.callback('🔄 Refresh', `refresh:${receiptId}`)],
      ]),
    }
  );
}
