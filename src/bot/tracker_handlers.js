// src/bot/tracker_handlers.js
// Personal Money Tracker — Dashboard, Budget, History, Export

import db from '../db/index.js';
import { formatMoney } from '../services/splitter.js';

function esc(t) { return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const HTML = { parse_mode: 'HTML' };

const CATEGORY_EMOJI = {
  'Food & Drinks': '🍽', 'Transport': '🚗', 'Entertainment': '🎬',
  'Shopping': '🛍', 'Travel': '✈️', 'Utilities': '⚡',
  'Healthcare': '🏥', 'Other': '📦',
};

// ─── /dashboard ──────────────────────────────────────────────────────────────

export async function handleDashboard(ctx) {
  const userId = ctx.from.id;
  const name   = esc(ctx.from.first_name);
  const now    = new Date();
  const month  = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  // Total paid this month (receipts where user is payer)
  const paid = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count
    FROM receipts
    WHERE payer_id = ? AND created_at >= ? AND status != 'cancelled'
  `).get(userId, monthStart);

  // What user owes others
  const owes = db.prepare(`
    SELECT COALESCE(SUM(s.amount), 0) as total
    FROM splits s
    WHERE s.debtor_id = ? AND s.status = 'pending'
  `).get(userId);

  // What others owe user
  const owed = db.prepare(`
    SELECT COALESCE(SUM(s.amount), 0) as total
    FROM splits s
    WHERE s.creditor_id = ? AND s.status = 'pending'
  `).get(userId);

  // Category breakdown this month
  const categories = db.prepare(`
    SELECT category, COALESCE(SUM(total_amount), 0) as total
    FROM receipts
    WHERE payer_id = ? AND created_at >= ? AND status != 'cancelled'
    GROUP BY category ORDER BY total DESC
  `).all(userId, monthStart);

  // Top merchants this month
  const merchants = db.prepare(`
    SELECT merchant, COALESCE(SUM(total_amount), 0) as total, COUNT(*) as visits
    FROM receipts
    WHERE payer_id = ? AND created_at >= ? AND status != 'cancelled'
    GROUP BY LOWER(merchant) ORDER BY total DESC LIMIT 5
  `).all(userId, monthStart);

  // Week over week comparison
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - now.getDay());
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const thisWeek = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) as total FROM receipts
    WHERE payer_id = ? AND created_at >= ? AND status != 'cancelled'
  `).get(userId, thisWeekStart.toISOString().slice(0, 10));

  const lastWeek = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) as total FROM receipts
    WHERE payer_id = ? AND created_at >= ? AND created_at < ? AND status != 'cancelled'
  `).get(userId, lastWeekStart.toISOString().slice(0, 10), thisWeekStart.toISOString().slice(0, 10));

  const totalPaid   = paid.total || 0;
  const totalOwes   = owes.total || 0;
  const totalOwed   = owed.total || 0;
  const netPosition = totalOwed - totalOwes;

  // Build bar chart (max 8 chars wide)
  function bar(amount, maxAmount) {
    const filled = Math.round((amount / maxAmount) * 8);
    return '█'.repeat(filled) + '░'.repeat(8 - filled);
  }
  const maxCat = categories[0]?.total || 1;

  let text = `📊 <b>${name}'s Dashboard — ${month}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  text += `💸 Total Paid:   <b>${formatMoney(totalPaid)}</b> (${paid.count} receipts)\n`;
  text += `📥 You're Owed:  <b>${formatMoney(totalOwed)}</b>\n`;
  text += `📤 You Owe:      <b>${formatMoney(totalOwes)}</b>\n`;
  text += `💰 Net Position: <b>${netPosition >= 0 ? '+' : ''}${formatMoney(netPosition)}</b>\n\n`;

  if (categories.length > 0) {
    text += `<b>📦 By Category:</b>\n`;
    for (const c of categories) {
      const emoji = CATEGORY_EMOJI[c.category] || '📦';
      const pct   = Math.round((c.total / totalPaid) * 100);
      text += `${emoji} ${esc(c.category).padEnd(14)} ${formatMoney(c.total)}  ${bar(c.total, maxCat)}  ${pct}%\n`;
    }
    text += '\n';
  }

  if (merchants.length > 0) {
    text += `<b>🏆 Top Merchants:</b>\n`;
    merchants.forEach((m, i) => {
      text += `${i + 1}. ${esc(m.merchant)}  <b>${formatMoney(m.total)}</b> (${m.visits}x)\n`;
    });
    text += '\n';
  }

  // Week trend
  const weekDiff = thisWeek.total - lastWeek.total;
  const weekPct  = lastWeek.total > 0 ? Math.round((weekDiff / lastWeek.total) * 100) : 0;
  const weekArrow = weekDiff > 0 ? '↑' : weekDiff < 0 ? '↓' : '→';
  const weekSign  = weekDiff > 0 ? '+' : '';
  text += `<b>📈 This Week vs Last:</b>\n`;
  text += `${formatMoney(thisWeek.total)} vs ${formatMoney(lastWeek.total)}  `;
  text += `<b>${weekSign}${weekPct}% ${weekArrow}</b>\n\n`;

  // Budget alerts inline
  const budgets = db.prepare(`SELECT * FROM budgets WHERE user_id = ?`).all(userId);
  if (budgets.length > 0) {
    text += `<b>🎯 Budget Status:</b>\n`;
    for (const b of budgets) {
      const spent = categories.find(c => c.category === b.category)?.total || 0;
      const pct   = Math.round((spent / b.limit_amount) * 100);
      const status = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
      text += `${status} ${esc(b.category)}: ${formatMoney(spent)} / ${formatMoney(b.limit_amount)} (${pct}%)\n`;
    }
    text += '\n';
  }

  text += `<i>Use /history to see receipts · /export for CSV</i>`;
  await ctx.reply(text, HTML);
}

// ─── /budget ─────────────────────────────────────────────────────────────────

export async function handleBudget(ctx) {
  const args = ctx.message.text.split(' ').slice(1);
  const sub  = args[0]?.toLowerCase();

  if (!sub || sub === 'list') {
    await showBudgets(ctx); return;
  }

  if (sub === 'set') {
    // /budget set food 5000
    const categoryArg = args[1];
    const limitArg    = parseFloat(args[2]);

    if (!categoryArg || !limitArg || isNaN(limitArg)) {
      await ctx.reply(
        `<b>🎯 Set a Budget</b>\n\nUsage: /budget set &lt;category&gt; &lt;amount&gt;\n\n` +
        `Categories:\n${Object.keys(CATEGORY_EMOJI).map(c => `• ${c}`).join('\n')}\n\n` +
        `Example: /budget set food 5000`, HTML); return;
    }

    // Fuzzy match category
    const category = Object.keys(CATEGORY_EMOJI).find(c =>
      c.toLowerCase().includes(categoryArg.toLowerCase())
    );

    if (!category) {
      await ctx.reply(`Unknown category: <b>${esc(categoryArg)}</b>\n\nTry: food, transport, shopping, entertainment, utilities, healthcare, travel`, HTML); return;
    }

    db.prepare(`
      INSERT INTO budgets (user_id, category, limit_amount, month)
      VALUES (?, ?, ?, strftime('%Y-%m', 'now'))
      ON CONFLICT(user_id, category, month) DO UPDATE SET limit_amount = excluded.limit_amount
    `).run(ctx.from.id, category, limitArg);

    await ctx.reply(
      `✅ Budget set!\n\n🎯 <b>${esc(category)}</b>: <b>${formatMoney(limitArg)}</b> / month\n\n<i>You'll get a warning at 80% and 100%</i>`,
      HTML);
    return;
  }

  if (sub === 'delete') {
    const category = Object.keys(CATEGORY_EMOJI).find(c =>
      c.toLowerCase().includes(args[1]?.toLowerCase() || '')
    );
    if (category) {
      db.prepare(`DELETE FROM budgets WHERE user_id = ? AND category = ?`).run(ctx.from.id, category);
      await ctx.reply(`🗑️ Budget removed for <b>${esc(category)}</b>`, HTML);
    } else {
      await ctx.reply('Category not found.'); 
    }
    return;
  }

  await ctx.reply('Usage: /budget list | /budget set &lt;category&gt; &lt;amount&gt; | /budget delete &lt;category&gt;', HTML);
}

async function showBudgets(ctx) {
  const budgets = db.prepare(`SELECT * FROM budgets WHERE user_id = ?`).all(ctx.from.id);

  if (budgets.length === 0) {
    await ctx.reply(
      `<b>🎯 No budgets set yet</b>\n\nSet one with:\n/budget set food 5000\n/budget set transport 2000`,
      HTML); return;
  }

  const now        = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  let text = `<b>🎯 Your Budgets</b>\n\n`;
  for (const b of budgets) {
    const spent = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total FROM receipts
      WHERE payer_id = ? AND category = ? AND created_at >= ? AND status != 'cancelled'
    `).get(ctx.from.id, b.category, monthStart);

    const pct    = Math.round((spent.total / b.limit_amount) * 100);
    const status = pct >= 100 ? '🔴 Over budget!' : pct >= 80 ? '🟡 Almost there' : '🟢 On track';
    text += `${CATEGORY_EMOJI[b.category] || '📦'} <b>${esc(b.category)}</b>\n`;
    text += `   ${formatMoney(spent.total)} / ${formatMoney(b.limit_amount)} — ${pct}% — ${status}\n\n`;
  }

  text += `<i>/budget set &lt;category&gt; &lt;amount&gt; to add/update</i>`;
  await ctx.reply(text, HTML);
}

// ─── Budget Alert Checker (called after every receipt scan) ──────────────────

export async function checkBudgetAlerts(telegram, userId, category, groupId) {
  try {
    const now        = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const budget = db.prepare(`
      SELECT * FROM budgets WHERE user_id = ? AND category = ?
    `).get(userId, category);

    if (!budget) return;

    const spent = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total FROM receipts
      WHERE payer_id = ? AND category = ? AND created_at >= ? AND status != 'cancelled'
    `).get(userId, category, monthStart);

    const pct = (spent.total / budget.limit_amount) * 100;

    if (pct >= 100 && pct < 110) {
      await telegram.sendMessage(userId,
        `🔴 <b>Budget Exceeded!</b>\n\n` +
        `You've gone over your <b>${category}</b> budget.\n` +
        `Spent: <b>${formatMoney(spent.total)}</b> / Limit: <b>${formatMoney(budget.limit_amount)}</b>`,
        HTML);
    } else if (pct >= 80 && pct < 90) {
      await telegram.sendMessage(userId,
        `🟡 <b>Budget Warning</b>\n\n` +
        `You're at ${Math.round(pct)}% of your <b>${category}</b> budget.\n` +
        `Spent: <b>${formatMoney(spent.total)}</b> / Limit: <b>${formatMoney(budget.limit_amount)}</b>\n\n` +
        `<i>${formatMoney(budget.limit_amount - spent.total)} remaining</i>`,
        HTML);
    }
  } catch (err) {
    console.error('[Budget Alert]', err.message);
  }
}

// ─── /history ────────────────────────────────────────────────────────────────

export async function handleHistory(ctx) {
  const args     = ctx.message.text.split(' ').slice(1);
  const filter   = args.join(' ').trim().toLowerCase();
  const userId   = ctx.from.id;

  let query, params;

  if (!filter) {
    // Last 10 receipts where user was payer
    query = `
      SELECT r.*, g.title as group_title FROM receipts r
      LEFT JOIN groups g ON g.id = r.group_id
      WHERE r.payer_id = ? AND r.status != 'cancelled'
      ORDER BY r.created_at DESC LIMIT 10`;
    params = [userId];
  } else {
    // Filter by category or merchant
    const matchedCategory = Object.keys(CATEGORY_EMOJI).find(c =>
      c.toLowerCase().includes(filter)
    );

    if (matchedCategory) {
      query = `
        SELECT r.*, g.title as group_title FROM receipts r
        LEFT JOIN groups g ON g.id = r.group_id
        WHERE r.payer_id = ? AND r.category = ? AND r.status != 'cancelled'
        ORDER BY r.created_at DESC LIMIT 15`;
      params = [userId, matchedCategory];
    } else {
      query = `
        SELECT r.*, g.title as group_title FROM receipts r
        LEFT JOIN groups g ON g.id = r.group_id
        WHERE r.payer_id = ? AND LOWER(r.merchant) LIKE ? AND r.status != 'cancelled'
        ORDER BY r.created_at DESC LIMIT 15`;
      params = [userId, `%${filter}%`];
    }
  }

  const receipts = db.prepare(query).all(...params);

  if (receipts.length === 0) {
    await ctx.reply(
      filter
        ? `No receipts found for "<b>${esc(filter)}</b>"\n\nTry: /history food, /history zomato`
        : `No receipts yet. Scan a receipt in your group to get started!`,
      HTML); return;
  }

  const totalShown = receipts.reduce((s, r) => s + r.total_amount, 0);
  const title = filter ? `"${esc(filter)}"` : 'Recent';

  let text = `<b>🧾 ${title} Receipts</b>\n`;
  text += `<i>${receipts.length} receipts · ${formatMoney(totalShown)} total</i>\n\n`;

  for (const r of receipts) {
    const date    = new Date(r.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const emoji   = CATEGORY_EMOJI[r.category] || '📦';
    const group   = r.group_title ? ` · ${esc(r.group_title)}` : '';
    text += `${emoji} <b>${esc(r.merchant)}</b> — <b>${formatMoney(r.total_amount)}</b>\n`;
    text += `   ${date}${group}\n\n`;
  }

  text += `<i>Filter: /history food · /history zomato · /history transport</i>`;
  await ctx.reply(text, HTML);
}

// ─── /export ─────────────────────────────────────────────────────────────────

export async function handleExport(ctx) {
  const userId = ctx.from.id;
  const now    = new Date();
  const args   = ctx.message.text.split(' ').slice(1);
  const period = args[0]?.toLowerCase();

  // Default: current month
  let startDate, label;
  if (period === 'all') {
    startDate = '2020-01-01';
    label = 'All Time';
  } else if (period === 'year') {
    startDate = `${now.getFullYear()}-01-01`;
    label = String(now.getFullYear());
  } else {
    startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    label = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }

  const receipts = db.prepare(`
    SELECT r.*, g.title as group_name,
      u.first_name || ' ' || COALESCE(u.last_name, '') as payer_name
    FROM receipts r
    LEFT JOIN groups g ON g.id = r.group_id
    LEFT JOIN users u ON u.id = r.payer_id
    WHERE r.payer_id = ? AND r.created_at >= ? AND r.status != 'cancelled'
    ORDER BY r.created_at DESC
  `).all(userId, startDate);

  if (receipts.length === 0) {
    await ctx.reply(`No receipts found for ${label}.`); return;
  }

  // Build CSV
  const lines = [
    'Date,Merchant,Category,Amount,Currency,Group,Status',
    ...receipts.map(r => {
      const date     = r.created_at.slice(0, 10);
      const merchant = `"${(r.merchant || '').replace(/"/g, '""')}"`;
      const group    = `"${(r.group_name || 'Personal').replace(/"/g, '""')}"`;
      return `${date},${merchant},${r.category},${r.total_amount},${r.currency || 'INR'},${group},${r.status}`;
    }),
  ];

  // Add summary at bottom
  const total = receipts.reduce((s, r) => s + r.total_amount, 0);
  lines.push('');
  lines.push(`Total,,, ${total.toFixed(2)},,,"${receipts.length} receipts"`);

  const csv      = lines.join('\n');
  const filename = `qbsplit_${label.replace(/\s/g, '_').toLowerCase()}.csv`;
  const buffer   = Buffer.from(csv, 'utf-8');

  await ctx.replyWithDocument(
    { source: buffer, filename },
    {
      caption:
        `📊 <b>Export: ${label}</b>\n` +
        `${receipts.length} receipts · ${formatMoney(total)}\n\n` +
        `<i>Open in Excel or Google Sheets</i>`,
      parse_mode: 'HTML',
    }
  );
}
