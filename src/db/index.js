// src/db/index.js
// Centralized DB connection + typed query helpers

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './data/snapbudget.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export default db;

// ─── User Helpers ─────────────────────────────────────────────────────────────

export const upsertUser = (telegramUser) => {
  return db.prepare(`
    INSERT INTO users (id, username, first_name, last_name)
    VALUES (@id, @username, @first_name, @last_name)
    ON CONFLICT(id) DO UPDATE SET
      username   = excluded.username,
      first_name = excluded.first_name,
      last_name  = excluded.last_name,
      updated_at = datetime('now')
  `).run({
    id: telegramUser.id,
    username: telegramUser.username || null,
    first_name: telegramUser.first_name,
    last_name: telegramUser.last_name || null,
  });
};

export const getUser = (userId) =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

// ─── Group Helpers ────────────────────────────────────────────────────────────

export const upsertGroup = (chat) => {
  return db.prepare(`
    INSERT INTO groups (id, title, type)
    VALUES (@id, @title, @type)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title
  `).run({ id: chat.id, title: chat.title, type: chat.type });
};

export const addGroupMember = (groupId, userId) => {
  db.prepare(`
    INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)
  `).run(groupId, userId);
};

export const getGroupMembers = (groupId) => {
  return db.prepare(`
    SELECT u.* FROM users u
    JOIN group_members gm ON gm.user_id = u.id
    WHERE gm.group_id = ?
  `).all(groupId);
};

// ─── Receipt Helpers ──────────────────────────────────────────────────────────

export const createReceipt = ({ id, groupId, payerId, merchant, totalAmount, category, ocrRaw, imageFileId, tripId = null, currency = 'INR', amountINR = null }) => {
  return db.prepare(`
    INSERT INTO receipts (id, group_id, payer_id, trip_id, merchant, total_amount, currency, amount_inr, category, ocr_raw, image_file_id)
    VALUES (@id, @groupId, @payerId, @tripId, @merchant, @totalAmount, @currency, @amountINR, @category, @ocrRaw, @imageFileId)
  `).run({ id, groupId, payerId, tripId, merchant, totalAmount, currency, amountINR: amountINR || totalAmount, category, ocrRaw, imageFileId });
};

export const getReceipt = (receiptId) =>
  db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);

export const updateReceiptStatus = (receiptId, status, splitMessageId = null) => {
  db.prepare(`
    UPDATE receipts SET status = ?, split_message_id = COALESCE(?, split_message_id)
    WHERE id = ?
  `).run(status, splitMessageId, receiptId);
};

export const createReceiptItems = (receiptId, items) => {
  const stmt = db.prepare(`
    INSERT INTO receipt_items (receipt_id, name, amount, is_tax, is_discount)
    VALUES (@receiptId, @name, @amount, @isTax, @isDiscount)
  `);
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      stmt.run({ receiptId, name: item.name, amount: item.amount, isTax: item.isTax ? 1 : 0, isDiscount: item.isDiscount ? 1 : 0 });
    }
  });
  insertMany(items);
};

export const getReceiptItems = (receiptId) =>
  db.prepare('SELECT * FROM receipt_items WHERE receipt_id = ?').all(receiptId);

// ─── Assignment Helpers ───────────────────────────────────────────────────────

export const assignItemToUsers = (itemId, userIds) => {
  const stmt = db.prepare('INSERT OR IGNORE INTO item_assignments (item_id, user_id) VALUES (?, ?)');
  const insertMany = db.transaction((ids) => {
    for (const uid of ids) stmt.run(itemId, uid);
  });
  insertMany(userIds);
};

export const getItemAssignments = (itemId) =>
  db.prepare('SELECT user_id FROM item_assignments WHERE item_id = ?').all(itemId).map(r => r.user_id);

// ─── Split Helpers ────────────────────────────────────────────────────────────

export const createSplitsAndUpdateMemory = (splits) => {
  const stmt = db.prepare(`
    INSERT INTO splits (receipt_id, debtor_id, creditor_id, amount)
    VALUES (@receiptId, @debtorId, @creditorId, @amount)
    ON CONFLICT(receipt_id, debtor_id, creditor_id) DO UPDATE SET amount = excluded.amount
  `);

  // Check if relationship_stats exists (requires migration to have been run)
  const hasMemoryTable = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='relationship_stats'
  `).get();

  db.transaction(() => {
    for (const s of splits) {
      stmt.run(s);
      // Update memory stats only if table exists
      if (hasMemoryTable) {
        db.prepare(`
          INSERT INTO relationship_stats (user_a, user_b, total_transactions, total_amount_ab)
          VALUES (?, ?, 1, ?)
          ON CONFLICT(user_a, user_b) DO UPDATE SET
            total_transactions = total_transactions + 1,
            total_amount_ab    = total_amount_ab + excluded.total_amount_ab,
            last_transaction   = datetime('now')
        `).run(s.debtorId, s.creditorId, s.amount);
      }
    }
  })();
};

export const createSplits = (splits) => {
  const stmt = db.prepare(`
    INSERT INTO splits (receipt_id, debtor_id, creditor_id, amount)
    VALUES (@receiptId, @debtorId, @creditorId, @amount)
    ON CONFLICT(receipt_id, debtor_id, creditor_id) DO UPDATE SET amount = excluded.amount
  `);
  db.transaction((splits) => { for (const s of splits) stmt.run(s); })(splits);
};

export const getSplitsForReceipt = (receiptId) => {
  return db.prepare(`
    SELECT s.*,
      d.first_name as debtor_name, d.username as debtor_username,
      c.first_name as creditor_name, c.username as creditor_username
    FROM splits s
    JOIN users d ON d.id = s.debtor_id
    JOIN users c ON c.id = s.creditor_id
    WHERE s.receipt_id = ?
  `).all(receiptId);
};

export const markSplitPaid = (receiptId, debtorId, chargeId = null) => {
  db.prepare(`
    UPDATE splits SET status = 'paid', paid_at = datetime('now'), payment_charge_id = ?
    WHERE receipt_id = ? AND debtor_id = ?
  `).run(chargeId, receiptId, debtorId);
};

// ─── Debt Simplification ──────────────────────────────────────────────────────
// Returns simplified net debts across ALL pending splits for a group

export const getSimplifiedDebts = (groupId) => {
  // Get all pending splits involving members of this group
  const rawDebts = db.prepare(`
    SELECT s.debtor_id, s.creditor_id, SUM(s.amount) as amount,
      d.first_name as debtor_name, c.first_name as creditor_name
    FROM splits s
    JOIN receipts r ON r.id = s.receipt_id
    JOIN users d ON d.id = s.debtor_id
    JOIN users c ON c.id = s.creditor_id
    WHERE r.group_id = ? AND s.status = 'pending'
    GROUP BY s.debtor_id, s.creditor_id
  `).all(groupId);

  // Build net balance map  {userId: netAmount}  positive = owed money, negative = owes money
  const balances = {};
  for (const debt of rawDebts) {
    balances[debt.debtor_id]   = (balances[debt.debtor_id]   || 0) - debt.amount;
    balances[debt.creditor_id] = (balances[debt.creditor_id] || 0) + debt.amount;
  }

  // Greedy simplification algorithm
  const creditors = Object.entries(balances).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const debtors   = Object.entries(balances).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]);
  const simplified = [];

  let i = 0, j = 0;
  const c = creditors.map(([id, amt]) => ({ id: Number(id), amt }));
  const d = debtors.map(([id, amt]) => ({ id: Number(id), amt: -amt }));

  while (i < c.length && j < d.length) {
    const settle = Math.min(c[i].amt, d[j].amt);
    simplified.push({ debtorId: d[j].id, creditorId: c[i].id, amount: Math.round(settle * 100) / 100 });
    c[i].amt -= settle;
    d[j].amt -= settle;
    if (c[i].amt < 0.01) i++;
    if (d[j].amt < 0.01) j++;
  }

  // Enrich with names
  return simplified.map(s => {
    const debtor   = getUser(s.debtorId);
    const creditor = getUser(s.creditorId);
    return { ...s, debtorName: debtor?.first_name, creditorName: creditor?.first_name };
  });
};

// ─── Stats Helpers ────────────────────────────────────────────────────────────

export const getUserMonthlyStats = (userId) => {
  const month = new Date().toISOString().slice(0, 7); // "2026-03"
  return db.prepare(`
    SELECT
      COUNT(DISTINCT r.id)                                    as total_receipts,
      COALESCE(SUM(CASE WHEN r.payer_id = ? THEN r.total_amount ELSE 0 END), 0) as total_paid,
      COALESCE(SUM(CASE WHEN s.debtor_id = ? AND s.status = 'pending' THEN s.amount ELSE 0 END), 0) as total_owed,
      COALESCE(SUM(CASE WHEN s.creditor_id = ? AND s.status = 'pending' THEN s.amount ELSE 0 END), 0) as total_receivable
    FROM receipts r
    LEFT JOIN splits s ON s.receipt_id = r.id
    WHERE r.created_at LIKE ? || '%'
      AND (r.payer_id = ? OR s.debtor_id = ? OR s.creditor_id = ?)
  `).get(userId, userId, userId, month, userId, userId, userId);
};

export const getUserCategoryBreakdown = (userId) => {
  const month = new Date().toISOString().slice(0, 7);
  return db.prepare(`
    SELECT r.category, SUM(s.amount) as total
    FROM splits s
    JOIN receipts r ON r.id = s.receipt_id
    WHERE s.debtor_id = ? AND r.created_at LIKE ? || '%'
    GROUP BY r.category
    ORDER BY total DESC
  `).all(userId, month);
};
