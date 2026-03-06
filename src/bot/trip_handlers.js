// src/bot/trip_handlers.js
// Trip Mode — /trip start, /trip end, /trip status

import db from '../db/index.js';
import { formatMoney } from '../services/splitter.js';
import { getSimplifiedDebts } from '../db/index.js';

function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const HTML = { parse_mode: 'HTML' };

// ─── /trip ───────────────────────────────────────────────────────────────────

export async function handleTrip(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Trip mode works in group chats only!'); return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === 'help') {
    await ctx.reply(
      `<b>🏕️ Trip Mode Commands</b>\n\n` +
      `/trip start &lt;name&gt; — Start a new trip\n` +
      `/trip end — End current trip &amp; show final settlement\n` +
      `/trip status — Current trip summary\n` +
      `/trip list — All trips for this group\n\n` +
      `<i>Example: /trip start Goa 2026</i>`, HTML);
    return;
  }

  if (subcommand === 'start') {
    await handleTripStart(ctx, args.slice(1).join(' '));
  } else if (subcommand === 'end') {
    await handleTripEnd(ctx);
  } else if (subcommand === 'status') {
    await handleTripStatus(ctx);
  } else if (subcommand === 'list') {
    await handleTripList(ctx);
  } else {
    await ctx.reply('Unknown subcommand. Try /trip help', HTML);
  }
}

async function handleTripStart(ctx, name) {
  if (!name || name.trim().length < 2) {
    await ctx.reply('Please provide a trip name.\nExample: /trip start Goa 2026'); return;
  }

  // Check if there's already an active trip
  const existing = db.prepare(`
    SELECT * FROM trips WHERE group_id = ? AND status = 'active'
  `).get(ctx.chat.id);

  if (existing) {
    await ctx.reply(
      `⚠️ Trip <b>${esc(existing.name)}</b> is already active!\nEnd it first with /trip end`,
      HTML); return;
  }

  const trip = db.prepare(`
    INSERT INTO trips (group_id, name, created_by, status)
    VALUES (?, ?, ?, 'active')
    RETURNING *
  `).get(ctx.chat.id, name.trim(), ctx.from.id);

  await ctx.reply(
    `🏕️ <b>Trip Started: ${esc(name.trim())}</b>\n\n` +
    `All receipts scanned in this group will now be tagged to this trip.\n\n` +
    `• Use /trip status to see live spending\n` +
    `• Use /trip end when the trip is over for final settlement`,
    HTML);
}

async function handleTripEnd(ctx) {
  const trip = db.prepare(`
    SELECT * FROM trips WHERE group_id = ? AND status = 'active'
  `).get(ctx.chat.id);

  if (!trip) {
    await ctx.reply('No active trip. Start one with /trip start &lt;name&gt;', HTML); return;
  }

  // End the trip
  db.prepare(`UPDATE trips SET status = 'ended', ended_at = datetime('now') WHERE id = ?`).run(trip.id);

  // Get trip summary
  const receipts = db.prepare(`
    SELECT r.*, u.first_name as payer_name
    FROM receipts r JOIN users u ON u.id = r.payer_id
    WHERE r.trip_id = ?
  `).all(trip.id);

  const totalSpent = receipts.reduce((s, r) => s + r.total_amount, 0);
  const debts = getSimplifiedDebts(ctx.chat.id);

  let text = `🏁 <b>Trip Ended: ${esc(trip.name)}</b>\n\n`;
  text += `📊 <b>Summary</b>\n`;
  text += `• Receipts: <b>${receipts.length}</b>\n`;
  text += `• Total spent: <b>${formatMoney(totalSpent)}</b>\n\n`;

  if (debts.length > 0) {
    text += `⚖️ <b>Final Settlement</b>\n`;
    for (const d of debts) {
      text += `• <b>${esc(d.debtorName)}</b> → <b>${esc(d.creditorName)}</b>: <b>${formatMoney(d.amount)}</b>\n`;
    }
  } else {
    text += `✅ <b>All settled! No outstanding debts.</b>`;
  }

  await ctx.reply(text, HTML);
}

async function handleTripStatus(ctx) {
  const trip = db.prepare(`
    SELECT * FROM trips WHERE group_id = ? AND status = 'active'
  `).get(ctx.chat.id);

  if (!trip) {
    await ctx.reply('No active trip. Start one with /trip start &lt;name&gt;', HTML); return;
  }

  // Include receipts explicitly tagged to trip OR created in this group after trip started
  const receipts = db.prepare(`
    SELECT r.*, u.first_name as payer_name
    FROM receipts r JOIN users u ON u.id = r.payer_id
    WHERE (r.trip_id = ?
      OR (r.group_id = ? AND r.created_at >= ? AND r.status != 'cancelled'))
    ORDER BY r.created_at DESC
  `).all(trip.id, trip.group_id, trip.started_at);

  const totalSpent = receipts.reduce((s, r) => s + r.total_amount, 0);

  // Category breakdown
  const byCategory = {};
  for (const r of receipts) {
    byCategory[r.category] = (byCategory[r.category] || 0) + r.total_amount;
  }

  // Who paid most
  const byPayer = {};
  for (const r of receipts) {
    byPayer[r.payer_name] = (byPayer[r.payer_name] || 0) + r.total_amount;
  }

  let text = `🏕️ <b>${esc(trip.name)}</b> — Live Status\n\n`;
  text += `💰 Total spent: <b>${formatMoney(totalSpent)}</b>\n`;
  text += `🧾 Receipts: <b>${receipts.length}</b>\n\n`;

  if (Object.keys(byCategory).length > 0) {
    text += `<b>By Category:</b>\n`;
    for (const [cat, amt] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      text += `• ${esc(cat)}: <b>${formatMoney(amt)}</b>\n`;
    }
    text += '\n';
  }

  if (Object.keys(byPayer).length > 0) {
    text += `<b>Who Paid:</b>\n`;
    for (const [name, amt] of Object.entries(byPayer).sort((a, b) => b[1] - a[1])) {
      text += `• ${esc(name)}: <b>${formatMoney(amt)}</b>\n`;
    }
  }

  await ctx.reply(text, HTML);
}

async function handleTripList(ctx) {
  const trips = db.prepare(`
    SELECT t.*, 
      COUNT(r.id) as receipt_count,
      COALESCE(SUM(r.total_amount), 0) as total_spent
    FROM trips t
    LEFT JOIN receipts r ON r.trip_id = t.id
    WHERE t.group_id = ?
    GROUP BY t.id
    ORDER BY t.started_at DESC
    LIMIT 10
  `).all(ctx.chat.id);

  if (trips.length === 0) {
    await ctx.reply('No trips yet. Start one with /trip start &lt;name&gt;', HTML); return;
  }

  let text = `<b>🗺️ Trip History</b>\n\n`;
  for (const trip of trips) {
    const status = trip.status === 'active' ? '🟢 Active' : '✅ Ended';
    text += `${status} <b>${esc(trip.name)}</b>\n`;
    text += `   ${trip.receipt_count} receipts · ${formatMoney(trip.total_spent)}\n\n`;
  }

  await ctx.reply(text, HTML);
}

// ─── Get active trip for group (used by photo handler) ───────────────────────

export function getActiveTrip(groupId) {
  return db.prepare(`SELECT * FROM trips WHERE group_id = ? AND status = 'active'`).get(groupId);
}