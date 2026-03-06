// src/services/oracle.js
// Expense Oracle — AI-powered monthly spending predictions

import db from '../db/index.js';
import { formatMoney } from './splitter.js';
import fetch from 'node-fetch';

const CATEGORY_EMOJI = {
  'Food & Drinks': '🍽', 'Transport': '🚗', 'Entertainment': '🎬',
  'Shopping': '🛍', 'Travel': '✈️', 'Utilities': '⚡',
  'Healthcare': '🏥', 'Other': '📦',
};

// ─── Main Oracle Entry Point ──────────────────────────────────────────────────

export async function generateOracle(userId, userName) {
  const history = getUserSpendingHistory(userId);

  // Works with any data — more months = better prediction
  if (history.monthsOfData === 0) {
    return {
      ready: false,
      monthsOfData: 0,
      message: `🔮 No spending data yet!\n\nScan a receipt in your group first, then come back.`,
    };
  }

  // Check cache — safe if oracle_predictions table missing (run migrate.js first)
  const hasOracleTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='oracle_predictions'`).get();
  // Cache key is NEXT month (what we're predicting)
  const nextMonthKey = (() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  const cached = hasOracleTable ? db.prepare(`
    SELECT * FROM oracle_predictions
    WHERE user_id = ? AND month = ?
    AND created_at > datetime('now', '-1 day')
    AND prediction_text IS NOT NULL AND LENGTH(prediction_text) > 20
  `).get(userId, nextMonthKey) : null;

  if (cached && cached.prediction_text && cached.prediction_text.trim().length > 20) {
    return { ready: true, prediction: cached.prediction_text, fromCache: true };
  }

  // Generate fresh prediction
  const prediction = await generatePrediction(userId, userName, history);

  // Cache it (only if table exists and prediction has real content)
  if (hasOracleTable && prediction && prediction.trim().length > 20) {
    db.prepare(`
      INSERT INTO oracle_predictions (user_id, month, prediction_text)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, month) DO UPDATE SET
        prediction_text = excluded.prediction_text,
        created_at      = datetime('now')
    `).run(userId, nextMonthKey, prediction);
  }

  return { ready: true, prediction, fromCache: false };
}

// ─── Gather Historical Spending Data ─────────────────────────────────────────

function getUserSpendingHistory(userId) {
  // Monthly totals for last 6 months
  const monthlyTotals = db.prepare(`
    SELECT
      strftime('%Y-%m', created_at) as month,
      COALESCE(SUM(total_amount), 0) as total,
      COUNT(*) as receipt_count
    FROM receipts
    WHERE payer_id = ? AND status != 'cancelled'
    GROUP BY strftime('%Y-%m', created_at)
    ORDER BY month DESC
    LIMIT 6
  `).all(userId);

  // Category breakdown per month
  const categoryHistory = db.prepare(`
    SELECT
      strftime('%Y-%m', created_at) as month,
      category,
      COALESCE(SUM(total_amount), 0) as total
    FROM receipts
    WHERE payer_id = ? AND status != 'cancelled'
    AND created_at >= date('now', '-6 months')
    GROUP BY strftime('%Y-%m', created_at), category
    ORDER BY month DESC
  `).all(userId);

  // Day of week spending patterns
  const dayPatterns = db.prepare(`
    SELECT
      strftime('%w', created_at) as dow,
      COALESCE(AVG(total_amount), 0) as avg_spend,
      COUNT(*) as count
    FROM receipts
    WHERE payer_id = ? AND status != 'cancelled'
    GROUP BY strftime('%w', created_at)
  `).all(userId);

  // Top merchants
  const topMerchants = db.prepare(`
    SELECT merchant, COUNT(*) as visits, SUM(total_amount) as total
    FROM receipts
    WHERE payer_id = ? AND status != 'cancelled'
    GROUP BY LOWER(merchant)
    ORDER BY visits DESC
    LIMIT 5
  `).all(userId);

  // Settlement behavior — join receipts for created_at since splits has no timestamp
  const settlementStats = db.prepare(`
    SELECT
      COUNT(*) as total_debts,
      SUM(CASE WHEN s.status = 'paid' THEN 1 ELSE 0 END) as settled,
      AVG(CASE WHEN s.status = 'paid'
        THEN CAST((julianday(s.paid_at) - julianday(r.created_at)) AS REAL)
        ELSE NULL END) as avg_days
    FROM splits s
    JOIN receipts r ON r.id = s.receipt_id
    WHERE s.debtor_id = ?
  `).get(userId);

  // Current month so far
  const currentMonth = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count
    FROM receipts
    WHERE payer_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    AND status != 'cancelled'
  `).get(userId);

  // Pending debts
  const pendingDebts = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
    FROM splits WHERE debtor_id = ? AND status = 'pending'
  `).get(userId);

  return {
    monthsOfData: monthlyTotals.length,
    monthlyTotals,
    categoryHistory,
    dayPatterns,
    topMerchants,
    settlementStats,
    currentMonth,
    pendingDebts,
  };
}

// ─── Generate Prediction via Gemini ──────────────────────────────────────────

async function generatePrediction(userId, userName, history) {
  const apiKey = process.env.GEMINI_API_KEY;

  // Build context for Gemini
  const monthlyStr = history.monthlyTotals
    .map(m => `${m.month}: ₹${m.total.toFixed(0)} (${m.receipt_count} receipts)`)
    .join(', ');

  const avgMonthly = history.monthlyTotals.length > 0
    ? history.monthlyTotals.reduce((s, m) => s + m.total, 0) / history.monthlyTotals.length
    : 0;

  // Predict NEXT month
  const nextMonthDate    = new Date(); nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
  const currentMonthName = nextMonthDate.toLocaleString('en-US', { month: 'long' });
  const currentYear      = nextMonthDate.getFullYear();

  // Top categories this month from history
  const topCats = history.categoryHistory
    .filter(c => c.month === history.monthlyTotals[0]?.month)
    .sort((a, b) => b.total - a.total)
    .slice(0, 4)
    .map(c => `${c.category}: ₹${c.total.toFixed(0)}`)
    .join(', ');

  const dow        = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const busiestDay = history.dayPatterns.sort((a, b) => b.avg_spend - a.avg_spend)[0];
  const busiestDayName = busiestDay ? dow[parseInt(busiestDay.dow)] : 'unknown';

  const pendingStr = history.pendingDebts.total > 0
    ? `Currently owes: ₹${history.pendingDebts.total.toFixed(0)} across ${history.pendingDebts.count} splits`
    : 'No pending debts';

  if (!apiKey) return generateRuleBasedPrediction(userName, history, avgMonthly, currentMonthName, busiestDayName);

  const prompt = `You are a personal finance oracle. Generate a SHORT, insightful monthly prediction for ${userName}.

Data:
- Monthly spending history: ${monthlyStr}
- Average monthly spend: ₹${avgMonthly.toFixed(0)}
- Current month so far: ₹${history.currentMonth.total.toFixed(0)} (${history.currentMonth.count} receipts)
- Top categories last month: ${topCats}
- Busiest spending day: ${busiestDayName}
- Top merchants: ${history.topMerchants.map(m => `${m.merchant}(${m.visits}x)`).join(', ')}
- Settlement: ${history.settlementStats?.avg_days ? Math.round(history.settlementStats.avg_days) + ' days avg' : 'unknown'}
- ${pendingStr}

Write a NEXT MONTH prediction for ${currentMonthName} ${currentYear} based on available spending data (even if only 1 month) with these sections:
1. One-line verdict (e.g. "Expensive month ahead ⚠️" or "You're on track 🟢")
2. Predicted total spend range (based on trend)  
3. 2-3 specific insights/warnings based on patterns
4. One actionable tip

Format as clean text with emojis. Keep it under 200 words. Be specific with numbers. Sound like a smart friend not a robot.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
        }),
      }
    );
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text || generateRuleBasedPrediction(userName, history, avgMonthly, currentMonthName, busiestDayName);
  } catch {
    return generateRuleBasedPrediction(userName, history, avgMonthly, currentMonthName, busiestDayName);
  }
}

// ─── Rule-based fallback ──────────────────────────────────────────────────────

function generateRuleBasedPrediction(userName, history, avgMonthly, monthName, busiestDay) {
  const current  = history.currentMonth.total;
  const trend    = current > avgMonthly * 0.6 ? 'on track for a higher month' : 'spending less than usual';
  const lowBound = Math.round(avgMonthly * 0.85);
  const highBound = Math.round(avgMonthly * 1.15);

  let text = `🔮 <b>${monthName} Forecast for ${userName}</b>\n\n`;
  text += `📊 Predicted spend: <b>${formatMoney(lowBound)} – ${formatMoney(highBound)}</b>\n`;
  text += `📍 So far this month: <b>${formatMoney(current)}</b>\n\n`;
  text += `💡 You're ${trend} based on your ${history.monthsOfData}-month average of ${formatMoney(avgMonthly)}.\n`;
  text += `📅 You tend to spend most on <b>${busiestDay}s</b> — plan accordingly.\n`;

  if (history.pendingDebts.total > 0) {
    text += `⚠️ You have <b>${formatMoney(history.pendingDebts.total)}</b> in unsettled debts — consider clearing these first.`;
  }

  return text;
}
