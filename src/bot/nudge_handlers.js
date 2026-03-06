// src/bot/nudge_handlers.js

import db from '../db/index.js';
import { formatMoney } from '../services/splitter.js';
import { getSimplifiedDebts } from '../db/index.js';

function esc(t) { return String(t??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
const HTML = { parse_mode: 'HTML' };

// ─── /nudge ──────────────────────────────────────────────────────────────────

export async function handleNudge(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Nudge works in group chats!'); return;
  }

  const debts  = getSimplifiedDebts(ctx.chat.id);
  const myDebts = debts.filter(d => d.creditorId === ctx.from.id);

  if (myDebts.length === 0) {
    await ctx.reply('✅ Nobody owes you anything right now!'); return;
  }

  let text = `👋 <b>Friendly Reminder</b> from <b>${esc(ctx.from.first_name)}</b>:\n\n`;
  for (const d of myDebts) {
    text += `• <b>${esc(d.debtorName)}</b> owes <b>${formatMoney(d.amount)}</b>\n`;
  }
  text += `\n<i>Use /balances to settle up! 💸</i>`;
  await ctx.reply(text, HTML);
}

// ─── /settle ─────────────────────────────────────────────────────────────────

export async function handleSettle(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Settle works in group chats!'); return;
  }

  const args = ctx.message.text.split(' ').slice(1);

  let targetUser = null;
  let amount     = null;

  // Parse args — supports @username, firstname, or full name + amount in any order
  // First pass: collect all number-like and name-like tokens
  const nameTokens = [];
  for (const arg of args) {
    const clean = arg.replace('₹', '').replace('@', '').trim();
    if (!isNaN(parseFloat(clean)) && parseFloat(clean) > 0) {
      amount = parseFloat(clean);
    } else if (clean.length > 0) {
      nameTokens.push(clean.toLowerCase());
    }
  }

  // Try to match name tokens against users (single word or full name)
  if (!targetUser && nameTokens.length > 0) {
    // Try single token match first
    for (const token of nameTokens) {
      const found = db.prepare(`
        SELECT * FROM users
        WHERE LOWER(username) = ?
           OR LOWER(first_name) = ?
           OR LOWER(last_name) = ?
        LIMIT 1
      `).get(token, token, token);
      if (found) { targetUser = found; break; }
    }

    // Try full name match (join all name tokens)
    if (!targetUser) {
      const fullName = nameTokens.join(' ');
      const found = db.prepare(`
        SELECT * FROM users
        WHERE LOWER(TRIM(first_name || ' ' || COALESCE(last_name, ''))) LIKE ?
           OR LOWER(first_name) LIKE ?
           OR LOWER(COALESCE(last_name,'')) LIKE ?
        LIMIT 1
      `).get(`%${fullName}%`, `%${nameTokens[0]}%`, `%${nameTokens[nameTokens.length-1]}%`);
      if (found) targetUser = found;
    }

    // Last resort: partial match on any token against all users in this group
    if (!targetUser) {
      const members = db.prepare(`
        SELECT u.* FROM users u
        JOIN group_members gm ON gm.user_id = u.id
        WHERE gm.group_id = ?
      `).all(ctx.chat.id);
      for (const token of nameTokens) {
        const match = members.find(m =>
          m.first_name?.toLowerCase().includes(token) ||
          m.last_name?.toLowerCase()?.includes(token) ||
          m.username?.toLowerCase()?.includes(token)
        );
        if (match) { targetUser = match; break; }
      }
    }
  }

  // If replying to a message — use that person
  if (!targetUser && ctx.message.reply_to_message?.from) {
    targetUser = db.prepare('SELECT * FROM users WHERE id = ?')
      .get(ctx.message.reply_to_message.from.id);
  }

  // /settle 2000 with no target — auto-pick whoever owes YOU the most (net)
  if (!targetUser && amount) {
    const debts = getSimplifiedDebts(ctx.chat.id);
    const oweMe = debts.filter(d => d.creditorId === ctx.from.id);
    if (oweMe.length > 0) {
      const top  = oweMe.sort((a, b) => b.amount - a.amount)[0];
      // Make sure it's a real user, not a ghost entry
      const user = db.prepare('SELECT * FROM users WHERE id = ? AND first_name IS NOT NULL').get(top.debtorId);
      if (user) targetUser = user;
    }
    // Also check if YOU owe someone — settle that too
    if (!targetUser) {
      const iOwe = debts.filter(d => d.debtorId === ctx.from.id);
      if (iOwe.length > 0) {
        const top  = iOwe.sort((a, b) => b.amount - a.amount)[0];
        const user = db.prepare('SELECT * FROM users WHERE id = ? AND first_name IS NOT NULL').get(top.creditorId);
        if (user) targetUser = user;
      }
    }
  }

  // Still no target — show who owes you and usage
  if (!targetUser) {
    const debts  = getSimplifiedDebts(ctx.chat.id);
    const oweMe  = debts.filter(d => d.creditorId === ctx.from.id);
    const owedMe = debts.filter(d => d.debtorId   === ctx.from.id);

    let text = `<b>💸 Settle a Payment</b>\n\n`;

    if (oweMe.length > 0) {
      text += `<b>People who owe you:</b>\n`;
      for (const d of oweMe) {
        text += `• ${esc(d.debtorName)}: <b>${formatMoney(d.amount)}</b>\n`;
      }
      text += '\n';
    }
    if (owedMe.length > 0) {
      text += `<b>You owe:</b>\n`;
      for (const d of owedMe) {
        text += `• ${esc(d.creditorName)}: <b>${formatMoney(d.amount)}</b>\n`;
      }
      text += '\n';
    }

    text += `<b>How to settle:</b>\n`;
    text += `/settle 2000 — auto-settles with biggest debtor\n`;
    text += `/settle @Pranav 2000 — settle specific person\n`;
    text += `Reply to their message + /settle 2000`;
    await ctx.reply(text, HTML);
    return;
  }

  // No amount — show what they owe
  if (!amount || amount <= 0) {
    const pending = db.prepare(`
      SELECT COALESCE(SUM(s.amount), 0) as total FROM splits s
      WHERE s.debtor_id = ? AND s.creditor_id = ? AND s.status = 'pending'
    `).get(ctx.from.id, targetUser.id);

    const pending2 = db.prepare(`
      SELECT COALESCE(SUM(s.amount), 0) as total FROM splits s
      WHERE s.debtor_id = ? AND s.creditor_id = ? AND s.status = 'pending'
    `).get(targetUser.id, ctx.from.id);

    await ctx.reply(
      `💬 Settling with <b>${esc(targetUser.first_name)}</b>\n\n` +
      (pending.total  > 0 ? `📤 You owe them: <b>${formatMoney(pending.total)}</b>\n`  : '') +
      (pending2.total > 0 ? `📥 They owe you: <b>${formatMoney(pending2.total)}</b>\n` : '') +
      `\nAdd an amount: /settle @${esc(targetUser.first_name)} 500`,
      HTML);
    return;
  }

  // ── Net balance settlement ──────────────────────────────────────────────────
  // Get ALL pending splits between these two users in BOTH directions
  // across the entire group (not just direct splits)
  const allSplits = db.prepare(`
    SELECT s.*, r.created_at
    FROM splits s
    JOIN receipts r ON r.id = s.receipt_id
    WHERE r.group_id = ? AND s.status = 'pending'
    AND (
      (s.debtor_id = ? AND s.creditor_id = ?)
      OR
      (s.debtor_id = ? AND s.creditor_id = ?)
    )
    ORDER BY r.created_at ASC
  `).all(ctx.chat.id,
    ctx.from.id, targetUser.id,
    targetUser.id, ctx.from.id
  );

  // Calculate net: positive = targetUser owes ctx.from, negative = ctx.from owes targetUser
  let net = 0;
  for (const s of allSplits) {
    if (s.creditor_id === ctx.from.id) net += s.amount;   // they owe me
    else                                net -= s.amount;   // I owe them
  }

  // Determine who is paying whom based on net
  // If net > 0: targetUser owes ctx.from → targetUser is payer
  // If net < 0: ctx.from owes targetUser → ctx.from is payer
  const payerName = net > 0 ? targetUser.first_name : ctx.from.first_name;
  const payeeName = net > 0 ? ctx.from.first_name   : targetUser.first_name;
  const netAbs    = Math.abs(net);

  if (netAbs < 0.01) {
    await ctx.reply(
      `✅ <b>Already settled!</b>\n\n` +
      `${esc(ctx.from.first_name)} and ${esc(targetUser.first_name)} are square. No pending balance.`,
      HTML);
    return;
  }

  // Settle splits greedily up to the payment amount
  let remaining    = amount;
  let settledCount = 0;

  // Sort: settle splits in the NET direction first
  const splitsToSettle = allSplits
    .filter(s => net > 0
      ? s.debtor_id === targetUser.id   // they owe me
      : s.debtor_id === ctx.from.id     // I owe them
    );

  // Also settle opposing splits (A paid for B, B paid for A — cancel each other)
  const splitsOpposite = allSplits
    .filter(s => net > 0
      ? s.debtor_id === ctx.from.id     // I owe them (offset)
      : s.debtor_id === targetUser.id   // they owe me (offset)
    );

  db.transaction(() => {
    // First cancel out opposing splits (net settlement)
    for (const s of splitsOpposite) {
      db.prepare(`UPDATE splits SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).run(s.id);
      settledCount++;
    }
    // Then settle remaining in net direction up to amount
    for (const s of splitsToSettle) {
      if (remaining <= 0.01) break;
      if (s.amount <= remaining + 0.01) {
        db.prepare(`UPDATE splits SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).run(s.id);
        remaining -= s.amount;
        settledCount++;
      }
    }
  })();

  const remainingNet = Math.max(0, netAbs - amount);

  await ctx.reply(
    `💚 <b>Payment Recorded!</b>\n\n` +
    `💸 <b>${esc(payerName)}</b> paid <b>${esc(payeeName)}</b>: <b>${formatMoney(amount)}</b>\n` +
    `✅ ${settledCount} split(s) settled\n` +
    (remainingNet > 0.01
      ? `⚠️ Still outstanding: <b>${formatMoney(remainingNet)}</b>\n`
      : `🎉 Fully settled between ${esc(ctx.from.first_name)} & ${esc(targetUser.first_name)}!\n`) +
    `\n<i>Use /balances to see updated totals</i>`,
    HTML);
}
