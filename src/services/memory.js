// src/services/memory.js
// Money Memory — tracks financial relationships between users over time

import db from '../db/index.js';
import fetch from 'node-fetch';
import { formatMoney } from './splitter.js';

// ─── Update relationship stats after every split ──────────────────────────────

export function updateRelationshipStats(debtorId, creditorId, amount) {
  db.prepare(`
    INSERT INTO relationship_stats (user_a, user_b, total_transactions, total_amount_ab)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(user_a, user_b) DO UPDATE SET
      total_transactions = total_transactions + 1,
      total_amount_ab    = total_amount_ab + excluded.total_amount_ab,
      last_transaction   = datetime('now')
  `).run(debtorId, creditorId, amount);
}

// ─── Update settlement speed after every payment ─────────────────────────────

export function recordSettlement(debtorId, creditorId, daysToSettle) {
  const existing = db.prepare(`
    SELECT * FROM relationship_stats WHERE user_a = ? AND user_b = ?
  `).get(debtorId, creditorId);

  if (!existing) return;

  const newCount   = (existing.settlements_count || 0) + 1;
  const currentAvg = existing.avg_days_to_settle || daysToSettle;
  const newAvg     = ((currentAvg * (newCount - 1)) + daysToSettle) / newCount;

  db.prepare(`
    UPDATE relationship_stats
    SET settlements_count  = ?,
        avg_days_to_settle = ?,
        total_settled      = total_settled + 1,
        last_settled_at    = datetime('now')
    WHERE user_a = ? AND user_b = ?
  `).run(newCount, Math.round(newAvg * 10) / 10, debtorId, creditorId);
}

// ─── Get full memory between two users ───────────────────────────────────────

export function getRelationshipMemory(userAId, userBId) {
  // Get both directions
  const ab = db.prepare(`SELECT * FROM relationship_stats WHERE user_a = ? AND user_b = ?`).get(userAId, userBId);
  const ba = db.prepare(`SELECT * FROM relationship_stats WHERE user_a = ? AND user_b = ?`).get(userBId, userAId);

  // Pending splits between these two users
  const pendingOwed = db.prepare(`
    SELECT COALESCE(SUM(s.amount), 0) as total, COUNT(*) as count
    FROM splits s
    WHERE s.debtor_id = ? AND s.creditor_id = ? AND s.status = 'pending'
  `).get(userAId, userBId);

  const pendingOwing = db.prepare(`
    SELECT COALESCE(SUM(s.amount), 0) as total, COUNT(*) as count
    FROM splits s
    WHERE s.debtor_id = ? AND s.creditor_id = ? AND s.status = 'pending'
  `).get(userBId, userAId);

  // Oldest unpaid debt — join receipts for created_at since splits has no timestamp
  const oldestDebt = db.prepare(`
    SELECT s.amount, r.created_at,
      CAST((julianday('now') - julianday(r.created_at)) AS INTEGER) as days_old
    FROM splits s
    JOIN receipts r ON r.id = s.receipt_id
    WHERE s.debtor_id = ? AND s.creditor_id = ? AND s.status = 'pending'
    ORDER BY r.created_at ASC LIMIT 1
  `).get(userAId, userBId);

  // Common groups
  const commonGroups = db.prepare(`
    SELECT DISTINCT g.title FROM groups g
    JOIN group_members gm1 ON gm1.group_id = g.id AND gm1.user_id = ?
    JOIN group_members gm2 ON gm2.group_id = g.id AND gm2.user_id = ?
  `).all(userAId, userBId);

  return {
    totalTransactions: (ab?.total_transactions || 0) + (ba?.total_transactions || 0),
    totalAmountExchanged: (ab?.total_amount_ab || 0) + (ba?.total_amount_ab || 0),
    timesAOwedB: ab?.total_transactions || 0,
    timesBOwedA: ba?.total_transactions || 0,
    totalAOwedB: ab?.total_amount_ab || 0,
    totalBOwedA: ba?.total_amount_ab || 0,
    totalSettledAB: ab?.total_settled || 0,
    totalSettledBA: ba?.total_settled || 0,
    avgDaysToSettleAB: ab?.avg_days_to_settle || null,
    avgDaysToSettleBA: ba?.avg_days_to_settle || null,
    pendingOwed: pendingOwed.total || 0,
    pendingOwedCount: pendingOwed.count || 0,
    pendingOwing: pendingOwing.total || 0,
    pendingOwingCount: pendingOwing.count || 0,
    oldestDebt,
    commonGroups: commonGroups.map(g => g.title),
    lastTransaction: ab?.last_transaction || ba?.last_transaction,
  };
}

// ─── Get all financial relationships for a user ───────────────────────────────

export function getAllRelationships(userId) {
  const people = db.prepare(`
    SELECT DISTINCT
      CASE WHEN rs.user_a = ? THEN rs.user_b ELSE rs.user_a END as other_id,
      u.first_name, u.username
    FROM relationship_stats rs
    JOIN users u ON u.id = CASE WHEN rs.user_a = ? THEN rs.user_b ELSE rs.user_a END
    WHERE rs.user_a = ? OR rs.user_b = ?
  `).all(userId, userId, userId, userId);

  return people.map(p => ({
    ...p,
    memory: getRelationshipMemory(userId, p.other_id),
  }));
}

// ─── Generate AI memory narrative ────────────────────────────────────────────

export async function generateMemoryNarrative(userAName, userBName, memory) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return generateRuleBasedNarrative(userAName, userBName, memory);

  try {
    const prompt = `You are a witty financial relationship analyst. Write a SHORT (3-4 sentences max), 
funny but friendly analysis of the financial relationship between ${userAName} and ${userBName}.

Data:
- ${userAName} has owed ${userBName} money ${memory.timesAOwedB} times (total: ₹${memory.totalAOwedB.toFixed(0)})
- ${userBName} has owed ${userAName} money ${memory.timesBOwedA} times (total: ₹${memory.totalBOwedA.toFixed(0)})
- Average days to settle: ${memory.avgDaysToSettleAB || 'unknown'} days
- Currently pending: ₹${memory.pendingOwed.toFixed(0)}
- Oldest unpaid debt: ${memory.oldestDebt ? memory.oldestDebt.days_old + ' days' : 'none'}

Be witty and use 1-2 emojis. Reference specific numbers. Don't be mean. Max 3 sentences.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 150 },
        }),
      }
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || generateRuleBasedNarrative(userAName, userBName, memory);
  } catch {
    return generateRuleBasedNarrative(userAName, userBName, memory);
  }
}

function generateRuleBasedNarrative(userAName, userBName, memory) {
  const avgDays = memory.avgDaysToSettleAB;
  const speed   = !avgDays ? 'unknown speed' : avgDays < 1 ? 'lightning fast ⚡' : avgDays < 3 ? 'pretty quickly' : avgDays < 7 ? 'within a week' : `${avgDays} days on average 🐢`;

  if (memory.totalTransactions === 0) return `${userAName} and ${userBName} are just getting started! No history yet.`;
  if (memory.timesAOwedB > memory.timesBOwedA * 2) return `${userAName} relies on ${userBName} a lot financially — ${memory.timesAOwedB} times and counting! ${userBName} is basically a personal bank. 🏦`;
  return `${userAName} and ${userBName} have split ${memory.totalTransactions} expenses worth ${formatMoney(memory.totalAmountExchanged)} together. ${userAName} usually settles at ${speed}.`;
}
