// src/index.js — QBSplit v2 — Full featured bot

import 'dotenv/config';
import { Telegraf } from 'telegraf';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import {
  trackContext,
  handleStart, handleHelp,
  handlePhoto, handleVoice,
  handleSplitEqual, handlePayCallback, handleCancelReceipt,
  handleRefresh,
  handleSuccessfulPayment,
  handleBalances,
  handleMyStats, handleMyBalances,
  handleManualSplit,
  handleChooseMembers, handleToggleMember, handleConfirmMembers,
  handleNaturalLanguage,
  handleConfirmPaid, handleMyUpi,
} from './bot/handlers.js';

import { handleTrip, getActiveTrip }                        from './bot/trip_handlers.js';
import { handleNudge, handleSettle }                         from './bot/nudge_handlers.js';
import { handleCurrency, handleSetCurrency }                 from './bot/currency_handlers.js';
import {
  handleRecurring,
  handleRecurringSetupMessage,
  handleRecurringFrequency,
  handleRecurringMemberToggle,
  handleRecurringConfirm,
}                                                             from './bot/recurring_handlers.js';
import { initScheduler }                                     from './services/scheduler.js';
import {
  handleDashboard, handleBudget, handleHistory, handleExport,
}                                                             from './bot/tracker_handlers.js';
import {
  handleMemory, handleOracle, pushWeeklyOracle, checkMemoryAlert,
}                                                             from './bot/memory_handlers.js';
import db                                                     from './db/index.js';
import {
  handleApprove, handleRejectExpense,
  handleClaimItems, handleClaimItem, handleConfirmClaims,
} from './bot/approval_handlers.js';
import {
  handleLeaderboard, handlePrivateBalance,
  handleSettleAll, handleSettleAllConfirm,
  handleEmojiCommand, handleEmojiConfirm,
} from './bot/leaderboard_handlers.js';
import apiRoutes                                             from './api/routes.js';

if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is required.');
  process.exit(1);
}

// ─── Bot ─────────────────────────────────────────────────────────────────────

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use(trackContext);

// ── Core commands ──────────────────────────────────────────────────────────
bot.start(handleStart);
bot.help(handleHelp);
bot.command('balances',   handleBalances);
bot.command('mybalances', handleMyBalances);
bot.command('mystats',    handleMyStats);
bot.command('stats',      handleMyStats);
bot.command('split',      handleManualSplit);

// ── v2 Feature commands ────────────────────────────────────────────────────
bot.command('trip',       handleTrip);
bot.command('nudge',      handleNudge);
bot.command('settle',     handleSettle);
bot.command('currency',   handleCurrency);
bot.command('recurring',  handleRecurring);

// ── Tracker commands ───────────────────────────────────────────────────────
bot.command('dashboard',  handleDashboard);
bot.command('budget',     handleBudget);
bot.command('history',    handleHistory);
bot.command('export',     handleExport);

// ── Memory + Oracle commands ───────────────────────────────────────────────
bot.command('memory',     handleMemory);
bot.command('myupi',      handleMyUpi);
bot.command('oracle',     handleOracle);

// ── Photo + Voice handlers ────────────────────────────────────────────────
bot.on('photo', handlePhoto);
bot.on('voice', handleVoice);

// ── Text messages — recurring setup → NLP → next ─────────────────────────
bot.on('text', async (ctx, next) => {
  const recurringHandled = await handleRecurringSetupMessage(ctx);
  if (recurringHandled) return;
  const emojiHandled = await handleEmojiCommand(ctx);
  if (emojiHandled) return;
  const nlpHandled = await handleNaturalLanguage(ctx);
  if (nlpHandled) return;
  return next();
});

// ── Callback routing ──────────────────────────────────────────────────────
bot.action(/^split_equal:/,   handleSplitEqual);
bot.action(/^pay:/,           handlePayCallback);
bot.action(/^cancel_receipt:/,handleCancelReceipt);
bot.action(/^refresh:/,       handleRefresh);
bot.action(/^rec_freq:/,      handleRecurringFrequency);
bot.action(/^rec_member:/,    handleRecurringMemberToggle);
bot.action('rec_confirm',     handleRecurringConfirm);
bot.action(/^set_currency:/,  handleSetCurrency);
bot.action(/^choose_members:/, handleChooseMembers);
bot.action(/^toggle_member:/,  handleToggleMember);
bot.action(/^confirm_members:/,handleConfirmMembers);
bot.action(/^confirm_paid:/,    handleConfirmPaid);
bot.action(/^approve:/,         handleApprove);
bot.action(/^reject_expense:/,  handleRejectExpense);
bot.action(/^claim_items:/,     handleClaimItems);
bot.action(/^claim_item:/,      handleClaimItem);
bot.action(/^confirm_claims:/,  handleConfirmClaims);
bot.action(/^settle_all_confirm:/, handleSettleAllConfirm);
bot.action(/^emoji_confirm:/,   handleEmojiConfirm);

bot.action(/^group_stats:/, async (ctx) => {
  await ctx.answerCbQuery();
  await handleMyStats(ctx);
});

// ── Payments ──────────────────────────────────────────────────────────────
bot.on('successful_payment', handleSuccessfulPayment);

// ── Error handler ─────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`Bot error [${ctx.updateType}]:`, err.message);
});

// ─── Express API ──────────────────────────────────────────────────────────────

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.MINI_APP_URL || '*', methods: ['GET','POST'] }));
app.use('/api', rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({
  status: 'ok', bot: 'QBSplit v2',
  features: ['ocr','trips','recurring','nudges','multi-currency'],
}));

app.post('/webhook', (req, res) => bot.handleUpdate(req.body, res));
app.use('/api', apiRoutes);

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`\n🚀 QBSplit v2 running on port ${PORT}`);

  if (process.env.NODE_ENV === 'production' && process.env.WEBHOOK_URL) {
    await bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook`, {
      secret_token: process.env.WEBHOOK_SECRET,
    });
    console.log(`🔗 Webhook: ${process.env.WEBHOOK_URL}/webhook`);
  } else {
    await bot.telegram.deleteWebhook();
    bot.launch();
    console.log('🤖 Polling mode (development)');
  }

  // Start background scheduler
  initScheduler(bot);

  // Weekly oracle push every Sunday at 9am
  setInterval(async () => {
    const now = new Date();
    if (now.getDay() === 0 && now.getHours() === 9 && now.getMinutes() < 5) {
      const users = db.prepare('SELECT id FROM users').all();
      for (const u of users) {
        await pushWeeklyOracle(bot.telegram, u.id).catch(() => {});
        await new Promise(r => setTimeout(r, 1000)); // rate limit
      }
    }
  }, 5 * 60 * 1000);

  const me = await bot.telegram.getMe();
  console.log(`✅ Ready! Bot: @${me.username}`);
  console.log(`\n📦 Features: OCR | Trip Mode | Recurring | Nudges | Multi-currency\n`);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
