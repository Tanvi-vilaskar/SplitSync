// src/api/routes.js
// REST API consumed by the Telegram Mini App (React frontend)

import { Router } from 'express';
import { createHmac } from 'crypto';

import db, {
  getReceipt, getReceiptItems, getGroupMembers,
  assignItemToUsers, createSplits, updateReceiptStatus,
  getSplitsForReceipt, getSimplifiedDebts,
  getUserMonthlyStats, getUserCategoryBreakdown,
} from '../db/index.js';

import { calculateSplits } from '../services/splitter.js';

const router = Router();

// ─── Telegram Mini App Auth Middleware ───────────────────────────────────────
// Validates the initData sent by Telegram to ensure request is legitimate

function validateTelegramWebApp(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];

  // Skip validation in development
  if (process.env.NODE_ENV === 'development') {
    req.telegramUserId = parseInt(req.headers['x-user-id']) || 123456789;
    return next();
  }

  if (!initData) return res.status(401).json({ error: 'Missing Telegram init data' });

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    // Sort params and create check string
    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // HMAC-SHA256 with key = HMAC-SHA256("WebAppData", BOT_TOKEN)
    const secretKey = createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN)
      .digest();

    const expectedHash = createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex');

    if (expectedHash !== hash) return res.status(401).json({ error: 'Invalid signature' });

    const user = JSON.parse(params.get('user') || '{}');
    req.telegramUserId = user.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Auth failed' });
  }
}

router.use(validateTelegramWebApp);

// ─── GET /api/receipt/:id ─────────────────────────────────────────────────────

router.get('/receipt/:id', (req, res) => {
  const receipt = getReceipt(req.params.id);
  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

  const items   = getReceiptItems(req.params.id);
  const members = getGroupMembers(receipt.group_id);

  // Attach current assignments to each item
  const itemsWithAssignments = items.map(item => {
    const assignments = db.prepare(
      'SELECT user_id FROM item_assignments WHERE item_id = ?'
    ).all(item.id).map(r => r.user_id);
    return { ...item, assignedTo: assignments };
  });

  res.json({ receipt, items: itemsWithAssignments, members });
});

// ─── POST /api/receipt/:id/assignments ───────────────────────────────────────
// Save item→user assignments from Mini App

router.post('/receipt/:id/assignments', (req, res) => {
  const { assignments } = req.body;
  // assignments: [{itemId: number, userIds: number[]}]

  if (!assignments || !Array.isArray(assignments)) {
    return res.status(400).json({ error: 'assignments array required' });
  }

  const receipt = getReceipt(req.params.id);
  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

  // Save all assignments in a transaction
  const saveAll = db.transaction(() => {
    // Clear existing assignments for this receipt's items
    const items = getReceiptItems(req.params.id);
    for (const item of items) {
      db.prepare('DELETE FROM item_assignments WHERE item_id = ?').run(item.id);
    }

    // Insert new assignments
    const stmt = db.prepare('INSERT OR IGNORE INTO item_assignments (item_id, user_id) VALUES (?, ?)');
    for (const { itemId, userIds } of assignments) {
      for (const uid of (userIds || [])) {
        stmt.run(itemId, uid);
      }
    }
  });

  saveAll();
  res.json({ success: true });
});

// ─── POST /api/receipt/:id/confirm ───────────────────────────────────────────
// Finalize splits after Mini App assignment

router.post('/receipt/:id/confirm', (req, res) => {
  const receipt = getReceipt(req.params.id);
  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

  const items   = getReceiptItems(req.params.id);
  const members = getGroupMembers(receipt.group_id);

  // Attach assignments
  const itemsWithAssignments = items.map(item => {
    const assignedTo = db.prepare(
      'SELECT user_id FROM item_assignments WHERE item_id = ?'
    ).all(item.id).map(r => r.user_id);
    return { ...item, assignedTo };
  });

  const splits = calculateSplits(
    receipt, itemsWithAssignments, receipt.payer_id, members.map(m => m.id)
  );

  createSplits(splits);
  updateReceiptStatus(req.params.id, 'assigned');

  const fullSplits = getSplitsForReceipt(req.params.id);
  const memberMap  = Object.fromEntries(members.map(m => [m.id, m]));

  res.json({ success: true, splits: fullSplits, members });
});

// ─── GET /api/group/:id/balances ──────────────────────────────────────────────

router.get('/group/:id/balances', (req, res) => {
  const debts   = getSimplifiedDebts(req.params.id);
  const members = getGroupMembers(req.params.id);
  res.json({ debts, members });
});

// ─── GET /api/user/stats ─────────────────────────────────────────────────────

router.get('/user/stats', (req, res) => {
  const stats = getUserMonthlyStats(req.telegramUserId);
  const cats  = getUserCategoryBreakdown(req.telegramUserId);
  res.json({ stats, categories: cats });
});

// ─── GET /api/user/balances ───────────────────────────────────────────────────

router.get('/user/balances', (req, res) => {
  const userGroups = db.prepare(`
    SELECT g.* FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
  `).all(req.telegramUserId);

  const result = [];
  for (const group of userGroups) {
    const debts = getSimplifiedDebts(group.id);
    const myDebts = debts.filter(d =>
      d.debtorId === req.telegramUserId || d.creditorId === req.telegramUserId
    );
    if (myDebts.length > 0) {
      result.push({ group, debts: myDebts });
    }
  }

  res.json({ groups: result });
});

// ─── GET /api/group/:id/receipts ─────────────────────────────────────────────

router.get('/group/:id/receipts', (req, res) => {
  const receipts = db.prepare(`
    SELECT r.*, u.first_name as payer_name
    FROM receipts r
    JOIN users u ON u.id = r.payer_id
    WHERE r.group_id = ? AND r.status != 'cancelled'
    ORDER BY r.created_at DESC
    LIMIT 20
  `).all(req.params.id);

  res.json({ receipts });
});

export default router;
