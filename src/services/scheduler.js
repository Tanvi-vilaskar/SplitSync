// src/services/scheduler.js
// Background job runner — nudges + recurring splits
// Runs checks every 60 seconds using setInterval (no external queue needed)

import db from '../db/index.js';
import { formatMoney } from './splitter.js';
import { refreshAllRates } from './currency.js';
import { v4 as uuidv4 } from 'uuid';

let botInstance = null;

export function initScheduler(bot) {
  botInstance = bot;

  // Check nudges every 60 seconds
  setInterval(processNudges, 60 * 1000);

  // Check recurring splits every 5 minutes
  setInterval(processRecurring, 5 * 60 * 1000);

  // Refresh exchange rates every 6 hours
  setInterval(refreshAllRates, 6 * 60 * 60 * 1000);

  // Auto-nudge all groups:
  // DEMO_MODE=true  → every 5 minutes
  // Production      → every day at 10am
  if (process.env.DEMO_MODE === 'true') {
    console.log('🎯 Demo mode: auto-nudge every 5 minutes');
    setInterval(processAutoNudge, 5 * 60 * 1000);
  } else {
    // Run daily at 10am
    setInterval(() => {
      const now = new Date();
      if (now.getHours() === 10 && now.getMinutes() < 2) {
        processAutoNudge();
      }
    }, 60 * 1000);
  }

  // Run once on startup (after 5s delay to let bot connect)
  setTimeout(() => {
    processNudges();
    processRecurring();
    refreshAllRates();
    processAutoNudge(); // send on startup too
  }, 5000);

  console.log('⏰ Scheduler started');
}

// ─── Nudge Processor ──────────────────────────────────────────────────────────

async function processNudges() {
  const due = db.prepare(`
    SELECT n.*, 
      d.first_name as debtor_name, d.username as debtor_username,
      c.first_name as creditor_name,
      g.title as group_title
    FROM nudge_schedule n
    JOIN users d ON d.id = n.debtor_id
    JOIN users c ON c.id = n.creditor_id
    JOIN groups g ON g.id = n.group_id
    WHERE n.sent = 0 AND n.send_at <= datetime('now')
    ORDER BY n.send_at ASC
    LIMIT 20
  `).all();

  for (const nudge of due) {
    try {
      // Send to group chat
      await botInstance.telegram.sendMessage(
        nudge.group_id,
        `👋 Hey ${nudge.debtor_username ? '@' + nudge.debtor_username : '<b>' + nudge.debtor_name + '</b>'}, friendly reminder — you owe <b>${nudge.creditor_name}</b> <b>${formatMoney(nudge.amount)}</b> 💸\n\n<i>Use /balances to settle up!</i>`,
        { parse_mode: 'HTML' }
      );

      // Mark sent + update split nudge count
      db.prepare(`UPDATE nudge_schedule SET sent = 1, sent_at = datetime('now') WHERE id = ?`).run(nudge.id);
      db.prepare(`
        UPDATE splits SET nudge_count = nudge_count + 1, last_nudged_at = datetime('now')
        WHERE id = ?
      `).run(nudge.split_id);

      console.log(`[Nudge] Sent to ${nudge.debtor_name} in ${nudge.group_title}`);
    } catch (err) {
      console.error(`[Nudge] Failed for id=${nudge.id}:`, err.message);
    }
  }
}

// ─── Schedule Nudges for a Receipt's Splits ───────────────────────────────────

export function scheduleNudges(splits, groupId) {
  const stmt = db.prepare(`
    INSERT INTO nudge_schedule (split_id, group_id, debtor_id, creditor_id, amount, send_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Nudge schedule: 24h, 72h, 7 days after split creation
  const delays = [24, 72, 168]; // hours

  db.transaction(() => {
    for (const split of splits) {
      for (const hours of delays) {
        const sendAt = new Date(Date.now() + hours * 60 * 60 * 1000)
          .toISOString().replace('T', ' ').slice(0, 19);
        stmt.run(split.id, groupId, split.debtor_id, split.creditor_id, split.amount, sendAt);
      }
    }
  })();
}

// ─── Cancel Nudges When Split is Paid ────────────────────────────────────────

export function cancelNudges(splitId) {
  db.prepare(`UPDATE nudge_schedule SET sent = 1 WHERE split_id = ? AND sent = 0`).run(splitId);
}

// ─── Recurring Split Processor ────────────────────────────────────────────────

async function processRecurring() {
  const due = db.prepare(`
    SELECT r.*, g.title as group_title
    FROM recurring_splits r
    JOIN groups g ON g.id = r.group_id
    WHERE r.active = 1 AND r.next_run <= datetime('now')
  `).all();

  for (const rec of due) {
    try {
      const memberIds = JSON.parse(rec.member_ids);
      const sharePerPerson = rec.amount / memberIds.length;

      // Post reminder to group
      const memberNames = memberIds
        .map(id => {
          const u = db.prepare('SELECT first_name FROM users WHERE id = ?').get(id);
          return u?.first_name || 'Unknown';
        })
        .join(', ');

      await botInstance.telegram.sendMessage(
        rec.group_id,
        `🔄 <b>Recurring Split Due: ${rec.name}</b>\n\n` +
        `💰 Total: <b>${formatMoney(rec.amount)}</b>\n` +
        `👥 Split between: ${memberNames}\n` +
        `💸 Each person owes: <b>${formatMoney(sharePerPerson)}</b>\n\n` +
        `<i>Use /balances to see full breakdown</i>`,
        { parse_mode: 'HTML' }
      );

      // Create actual splits in DB
      const receiptId = uuidv4();
      db.prepare(`
        INSERT INTO receipts (id, group_id, payer_id, merchant, total_amount, currency, category, status)
        VALUES (?, ?, ?, ?, ?, ?, 'Utilities', 'assigned')
      `).run(receiptId, rec.group_id, rec.payer_id, rec.name, rec.amount, rec.currency);

      const splitStmt = db.prepare(`
        INSERT INTO splits (receipt_id, debtor_id, creditor_id, amount)
        VALUES (?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (const memberId of memberIds) {
          if (memberId !== rec.payer_id) {
            splitStmt.run(receiptId, memberId, rec.payer_id, Math.round(sharePerPerson * 100) / 100);
          }
        }
      })();

      // Calculate next run date
      const nextRun = getNextRunDate(rec.frequency);
      db.prepare(`UPDATE recurring_splits SET next_run = ? WHERE id = ?`).run(nextRun, rec.id);

      console.log(`[Recurring] Processed "${rec.name}" for group ${rec.group_title}`);
    } catch (err) {
      console.error(`[Recurring] Failed for id=${rec.id}:`, err.message);
    }
  }
}

// ─── Auto Nudge — sends personal debt summary to each member ─────────────────

async function processAutoNudge() {
  console.log('[AutoNudge] Running...');
  try {
    const groups = db.prepare(`SELECT * FROM groups`).all();
    for (const group of groups) {
      if (group.active === 0) continue;
      try {
        await processGroupNudge(group);
      } catch (err) {
        const is403 = err.message?.includes('403') || err.message?.includes('kicked') ||
          err.message?.includes('blocked') || err.message?.includes('chat not found') ||
          err.message?.includes('deactivated');
        if (is403) {
          console.log(`[AutoNudge] Bot removed from "${group.title}" — marking inactive`);
          try { db.prepare(`UPDATE groups SET active = 0 WHERE id = ?`).run(group.id); } catch { }
        } else {
          console.error(`[AutoNudge] Error in "${group.title}":`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[AutoNudge] Fatal:', err.message);
  }
}


// ─── Per-group nudge logic (extracted so errors are caught per-group) ─────────

async function processGroupNudge(group) {
  const rawDebts = db.prepare(`
    SELECT s.debtor_id, s.creditor_id, SUM(s.amount) as amount
    FROM splits s
    JOIN receipts r ON r.id = s.receipt_id
    WHERE r.group_id = ? AND s.status = 'pending'
    GROUP BY s.debtor_id, s.creditor_id
  `).all(group.id);

  if (rawDebts.length === 0) return;

  // Build net balance map
  const balances = {};
  for (const debt of rawDebts) {
    balances[debt.debtor_id] = (balances[debt.debtor_id] || 0) - debt.amount;
    balances[debt.creditor_id] = (balances[debt.creditor_id] || 0) + debt.amount;
  }

  const creditors = Object.entries(balances).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]);
  const debtors = Object.entries(balances).filter(([, v]) => v < -0.01).sort((a, b) => a[1] - b[1]);
  const simplified = [];
  let i = 0, j = 0;
  const c = creditors.map(([id, amt]) => ({ id: Number(id), amt }));
  const d = debtors.map(([id, amt]) => ({ id: Number(id), amt: -amt }));

  while (i < c.length && j < d.length) {
    const settle = Math.min(c[i].amt, d[j].amt);
    simplified.push({ debtorId: d[j].id, creditorId: c[i].id, amount: Math.round(settle * 100) / 100 });
    c[i].amt -= settle; d[j].amt -= settle;
    if (c[i].amt < 0.01) i++;
    if (d[j].amt < 0.01) j++;
  }

  if (simplified.length === 0) return;

  // DM each debtor privately
  const debtorMap = {};
  for (const s of simplified) {
    if (!debtorMap[s.debtorId]) debtorMap[s.debtorId] = [];
    const creditor = db.prepare('SELECT first_name FROM users WHERE id = ?').get(s.creditorId);
    debtorMap[s.debtorId].push({ name: creditor?.first_name || 'someone', amount: s.amount });
  }

  for (const [userId, debts] of Object.entries(debtorMap)) {
    const total = debts.reduce((s, d) => s + d.amount, 0);
    let msg = `⏰ <b>Payment Reminder — ${group.title}</b>

`;
    msg += `You have <b>${formatMoney(total)}</b> pending:

`;
    for (const d of debts) msg += `• Pay <b>${d.name}</b>: <b>${formatMoney(d.amount)}</b>
`;
    msg += `
<i>Use /settle in the group to mark as paid 💸</i>`;

    try {
      await botInstance.telegram.sendMessage(Number(userId), msg, { parse_mode: 'HTML' });
      console.log(`[AutoNudge] DM sent to user ${userId} in "${group.title}"`);
    } catch {
      // Can't DM — tag in group instead
      const user = db.prepare('SELECT first_name, username FROM users WHERE id = ?').get(Number(userId));
      const tag = user?.username ? `@${user.username}` : `<b>${user?.first_name || 'Someone'}</b>`;
      let gMsg = `⏰ ${tag} you have <b>${formatMoney(total)}</b> pending:
`;
      for (const d of debts) gMsg += `• Pay <b>${d.name}</b>: <b>${formatMoney(d.amount)}</b>
`;
      gMsg += `
<i>/settle to mark as paid</i>`;
      await botInstance.telegram.sendMessage(group.id, gMsg, { parse_mode: 'HTML' });
    }
  }

  // Group summary
  let summary = `📊 <b>Settlement Summary — ${group.title}</b>

`;
  for (const s of simplified) {
    const debtor = db.prepare('SELECT first_name FROM users WHERE id = ?').get(s.debtorId);
    const creditor = db.prepare('SELECT first_name FROM users WHERE id = ?').get(s.creditorId);
    summary += `• <b>${debtor?.first_name}</b> → <b>${creditor?.first_name}</b>: <b>${formatMoney(s.amount)}</b>
`;
  }
  summary += `
<i>Use /settle to clear your dues 💸</i>`;
  await botInstance.telegram.sendMessage(group.id, summary, { parse_mode: 'HTML' });
}

function getNextRunDate(frequency) {
  const now = new Date();
  switch (frequency) {
    case 'daily': now.setDate(now.getDate() + 1); break;
    case 'weekly': now.setDate(now.getDate() + 7); break;
    case 'monthly': now.setMonth(now.getMonth() + 1); break;
    case 'yearly': now.setFullYear(now.getFullYear() + 1); break;
  }
  return now.toISOString().replace('T', ' ').slice(0, 19);
}