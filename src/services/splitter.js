// src/services/splitter.js
// Calculates how much each person owes after item assignments

/**
 * Calculate splits from item assignments.
 *
 * @param {Object} receipt      - Receipt row from DB
 * @param {Array}  items        - Receipt items with assigned user IDs
 * @param {number} payerId      - User who paid the full bill
 * @param {Array}  allMemberIds - All group members (for auto-split items)
 * @returns {Array} splits      - [{debtorId, creditorId, amount}]
 */
export function calculateSplits(receipt, items, payerId, allMemberIds) {
  // memberOwes: {userId: amount}
  const memberOwes = {};

  for (const item of items) {
    if (item.isDiscount) continue; // discounts already reduce item totals

    // Determine who shares this item
    let participants;
    if (item.isTax || !item.assignedTo || item.assignedTo.length === 0) {
      // Tax/unassigned items split equally among all members
      participants = allMemberIds;
    } else {
      participants = item.assignedTo;
    }

    const sharePerPerson = item.amount / participants.length;

    for (const userId of participants) {
      memberOwes[userId] = (memberOwes[userId] || 0) + sharePerPerson;
    }
  }

  // Build split entries: everyone owes the payer (except the payer themselves)
  const splits = [];
  for (const [userIdStr, amount] of Object.entries(memberOwes)) {
    const userId = Number(userIdStr);
    if (userId === payerId) continue; // payer doesn't owe themselves
    if (amount < 0.50) continue;     // skip trivial amounts under ₹0.50

    splits.push({
      receiptId:   receipt.id,
      debtorId:    userId,
      creditorId:  payerId,
      amount:      Math.round(amount * 100) / 100,
    });
  }

  return splits;
}

/**
 * Format a splits summary as human-readable text for Telegram.
 */
export function formatSplitCard(receipt, splits, memberMap) {
  const categoryEmoji = {
    'Food & Drinks': '🍽️', 'Transport': '🚗', 'Entertainment': '🎬',
    'Shopping': '🛍️', 'Travel': '✈️', 'Utilities': '⚡',
    'Healthcare': '🏥', 'Other': '📦',
  };

  const esc     = (t) => String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const emoji   = categoryEmoji[receipt.category] || '🧾';
  const total   = formatMoney(receipt.total_amount);
  const merchant = receipt.merchant || 'Unknown Merchant';

  let text = `${emoji} <b>${esc(merchant)}</b>\n`;
  text += `💰 Total: <b>${total}</b>\n\n`;

  if (splits.length === 0) {
    text += '✅ No outstanding splits.\n';
    return text;
  }

  text += `📋 <b>Who owes what:</b>\n`;
  for (const split of splits) {
    const debtor   = memberMap[split.debtor_id]   || { first_name: 'Unknown' };
    const creditor = memberMap[split.creditor_id] || { first_name: 'Unknown' };
    const status   = split.status === 'paid' ? '✅' : '⏳';
    text += `${status} ${esc(debtor.first_name)} → ${esc(creditor.first_name)}: <b>${formatMoney(split.amount)}</b>\n`;
  }

  const pending = splits.filter(s => s.status === 'pending');
  if (pending.length > 0) {
    text += `\n<i>${pending.length} payment${pending.length > 1 ? 's' : ''} pending</i>`;
  } else {
    text += `\n✅ <i>All settled up!</i>`;
  }

  return text;
}

export function formatMoney(amount, currency = 'INR') {
  if (currency === 'INR') return `₹${Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  return `$${Number(amount).toFixed(2)}`;
}

export function escapeMarkdown(text) {
  // All characters that must be escaped in Telegram MarkdownV2
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, '\\$&');
}
