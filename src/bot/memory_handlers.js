// src/bot/memory_handlers.js
// Money Memory + Expense Oracle handlers

import db from '../db/index.js';
import { formatMoney } from '../services/splitter.js';
import { getRelationshipMemory, getAllRelationships, generateMemoryNarrative } from '../services/memory.js';
import { generateOracle } from '../services/oracle.js';

function esc(t) { return String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
const HTML = { parse_mode: 'HTML' };

// ─── /memory ─────────────────────────────────────────────────────────────────

export async function handleMemory(ctx) {
  const args       = ctx.message.text.split(' ').slice(1);
  const targetArg  = args[0];
  const userId     = ctx.from.id;
  const userName   = ctx.from.first_name;

  // /memory @username or /memory username — specific person
  if (targetArg) {
    const lookup = targetArg.replace('@', '').toLowerCase();
    const target = db.prepare(`
      SELECT * FROM users
      WHERE LOWER(username) = ? OR LOWER(first_name) = ?
      LIMIT 1
    `).get(lookup, lookup);

    if (!target) {
      await ctx.reply(`User "<b>${esc(targetArg)}</b>" not found.\n\nUse /memory to see all your financial relationships.`, HTML);
      return;
    }

    await showPairMemory(ctx, userId, userName, target.id, target.first_name);
    return;
  }

  // /memory — show all relationships overview
  await showAllMemory(ctx, userId, userName);
}

async function showPairMemory(ctx, userAId, userAName, userBId, userBName) {
  const memory    = getRelationshipMemory(userAId, userBId);
  const narrative = await generateMemoryNarrative(userAName, userBName, memory);

  let text = `🧠 <b>Money Memory: ${esc(userAName)} × ${esc(userBName)}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // AI narrative
  text += `💬 <i>${esc(narrative)}</i>\n\n`;

  // Core stats
  text += `<b>📊 All-Time Stats:</b>\n`;
  text += `🔄 Total splits together: <b>${memory.totalTransactions}</b>\n`;
  text += `💸 Total money exchanged: <b>${formatMoney(memory.totalAmountExchanged)}</b>\n\n`;

  // Who owes more
  if (memory.timesAOwedB > 0 || memory.timesBOwedA > 0) {
    text += `<b>⚖️ Balance of Owing:</b>\n`;
    if (memory.timesAOwedB > 0)
      text += `• ${esc(userAName)} → ${esc(userBName)}: ${memory.timesAOwedB}x (${formatMoney(memory.totalAOwedB)} total)\n`;
    if (memory.timesBOwedA > 0)
      text += `• ${esc(userBName)} → ${esc(userAName)}: ${memory.timesBOwedA}x (${formatMoney(memory.totalBOwedA)} total)\n`;
    text += '\n';
  }

  // Settlement speed
  if (memory.avgDaysToSettleAB) {
    const speed = memory.avgDaysToSettleAB < 1 ? '⚡ same day'
      : memory.avgDaysToSettleAB < 3 ? '✅ within 3 days'
      : memory.avgDaysToSettleAB < 7 ? '🟡 within a week'
      : `🐢 ${memory.avgDaysToSettleAB} days on average`;
    text += `<b>⏱ Settlement Speed:</b> ${speed}\n\n`;
  }

  // Current pending
  if (memory.pendingOwed > 0) {
    text += `<b>⚠️ Currently Pending:</b>\n`;
    text += `📤 You owe <b>${esc(userBName)}</b>: <b>${formatMoney(memory.pendingOwed)}</b>`;
    if (memory.oldestDebt) text += ` (oldest: ${memory.oldestDebt.days_old} days old)`;
    text += '\n\n';
  } else if (memory.pendingOwing > 0) {
    text += `<b>📥 Currently Pending:</b>\n`;
    text += `<b>${esc(userBName)}</b> owes you: <b>${formatMoney(memory.pendingOwing)}</b>\n\n`;
  } else {
    text += `✅ <b>All settled up!</b> No pending amounts.\n\n`;
  }

  // Common groups
  if (memory.commonGroups.length > 0) {
    text += `<b>👥 Shared Groups:</b> ${memory.commonGroups.map(g => esc(g)).join(', ')}\n`;
  }

  await ctx.reply(text, HTML);
}

async function showAllMemory(ctx, userId, userName) {
  const relationships = getAllRelationships(userId);

  if (relationships.length === 0) {
    await ctx.reply(
      `🧠 <b>Money Memory</b>\n\nNo financial relationships tracked yet.\n\nSplit a bill in a group to start building your memory!`,
      HTML); return;
  }

  // Sort by total amount exchanged
  relationships.sort((a, b) => b.memory.totalAmountExchanged - a.memory.totalAmountExchanged);

  let text = `🧠 <b>${esc(userName)}'s Money Memory</b>\n`;
  text += `<i>${relationships.length} financial relationship${relationships.length > 1 ? 's' : ''} tracked</i>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const rel of relationships.slice(0, 8)) {
    const m      = rel.memory;
    const status = m.pendingOwed > 0
      ? `📤 You owe <b>${formatMoney(m.pendingOwed)}</b>`
      : m.pendingOwing > 0
        ? `📥 Owed <b>${formatMoney(m.pendingOwing)}</b>`
        : '✅ Settled';

    const speedEmoji = !m.avgDaysToSettleAB ? ''
      : m.avgDaysToSettleAB < 2  ? ' ⚡'
      : m.avgDaysToSettleAB < 5  ? ' ✅'
      : m.avgDaysToSettleAB < 14 ? ' 🟡'
      : ' 🐢';

    text += `👤 <b>${esc(rel.first_name)}</b>${speedEmoji}\n`;
    text += `   ${m.totalTransactions} splits · ${formatMoney(m.totalAmountExchanged)} · ${status}\n\n`;
  }

  text += `<i>Use /memory @name for detailed relationship analysis</i>`;
  await ctx.reply(text, HTML);
}

// ─── Auto-trigger memory alert when same person owes 3+ times ───────────────

export async function checkMemoryAlert(bot, groupId, debtorId, creditorId) {
  try {
    const stats = db.prepare(`
      SELECT * FROM relationship_stats WHERE user_a = ? AND user_b = ?
    `).get(debtorId, creditorId);

    // Trigger alert at 3rd, 5th, 10th time
    const triggerPoints = [3, 5, 10];
    const count = stats?.total_transactions || 0;

    if (!triggerPoints.includes(count)) return;

    const debtor   = db.prepare('SELECT * FROM users WHERE id = ?').get(debtorId);
    const creditor = db.prepare('SELECT * FROM users WHERE id = ?').get(creditorId);
    if (!debtor || !creditor) return;

    const pending = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM splits
      WHERE debtor_id = ? AND creditor_id = ? AND status = 'pending'
    `).get(debtorId, creditorId);

    await bot.sendMessage(groupId,
      `🧠 <b>Money Memory Unlocked!</b>\n\n` +
      `This is the <b>${count}th time</b> <b>${esc(debtor.first_name)}</b> has owed <b>${esc(creditor.first_name)}</b> money.\n` +
      `💸 Total owed over time: <b>${formatMoney(stats.total_amount_ab)}</b>\n` +
      `⏳ Currently pending: <b>${formatMoney(pending.total)}</b>\n\n` +
      `<i>Use /memory @${esc(debtor.first_name)} to see the full history</i>`,
      HTML);
  } catch (err) {
    console.error('[Memory Alert]', err.message);
  }
}

// ─── /oracle ─────────────────────────────────────────────────────────────────

export async function handleOracle(ctx) {
  const userId   = ctx.from.id;
  const userName = ctx.from.first_name;

  await ctx.reply('🔮 Consulting the oracle...', HTML);

  const result = await generateOracle(userId, userName);

  if (!result.ready) {
    await ctx.reply(result.message, HTML);
    return;
  }

  const nextMonth  = new Date(); nextMonth.setMonth(nextMonth.getMonth() + 1);
  const monthName  = nextMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const cached     = result.fromCache ? '\n<i>(cached — updates daily)</i>' : '';

  await ctx.reply(
    `🔮 <b>Next Month Forecast — ${monthName}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    result.prediction +
    cached,
    HTML);
}

// ─── Weekly Oracle Push (called by scheduler every Sunday) ──────────────────

export async function pushWeeklyOracle(bot, userId) {
  try {
    const user   = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return;

    const result = await generateOracle(userId, user.first_name);
    if (!result.ready) return;

    await bot.sendMessage(userId,
      `🔮 <b>Your Weekly Expense Oracle</b>\n\n` +
      result.prediction +
      `\n\n<i>Use /oracle anytime for your full forecast</i>`,
      HTML);
  } catch (err) {
    console.error('[Oracle Push]', err.message);
  }
}
