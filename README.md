# SnapBudget Social — Telegram Bot Backend

> Snap a receipt → assign items → split with your group. All inside Telegram.

---

## Architecture

```
snapbudget/
├── src/
│   ├── index.js              # Entry point: bot + express server
│   ├── bot/
│   │   └── handlers.js       # All Telegram bot handlers
│   ├── services/
│   │   ├── ocr.js            # Receipt scanning (Google Vision / Tesseract)
│   │   ├── categorizer.js    # AI categorization (Claude API)
│   │   └── splitter.js       # Split calculation + debt simplification
│   ├── api/
│   │   └── routes.js         # REST API for Mini App
│   └── db/
│       ├── index.js          # SQLite helpers + query functions
│       └── migrate.js        # Schema migration (run once)
├── .env.example              # Copy to .env and fill in values
└── package.json
```

---

## Quick Start

### 1. Create your Telegram Bot

1. Open Telegram → search **@BotFather**
2. Send `/newbot` → follow prompts → copy your **BOT_TOKEN**
3. Send `/setcommands` and paste:
   ```
   start - Welcome message
   help - Show all commands
   split - Quickly split an amount equally
   balances - See who owes what
   mystats - Your monthly spending stats
   mybalances - Your debts across all groups
   ```

### 2. Set up Google Vision API (for OCR)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → Enable **Cloud Vision API**
3. Create an API key → copy it
4. Paste into `.env` as `GOOGLE_VISION_API_KEY`

**Or use free Tesseract (no API key needed):**
```bash
npm install tesseract.js
# In .env: OCR_ENGINE=tesseract
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### 4. Install & run

```bash
npm install
node src/db/migrate.js     # Create database schema
npm run dev                # Start in development (polling mode)
```

### 5. Add bot to a group

1. Open Telegram → your group → Add Members → search your bot
2. Make the bot an **Admin** (needed to read messages)
3. Send a receipt photo — the bot will respond!

---

## Deployment (Production)

### Deploy to Railway (recommended, free tier available)

```bash
npm install -g @railway/cli
railway login
railway new
railway add
railway up
```

Set environment variables in Railway dashboard.

### Deploy to a VPS

```bash
# Install Node 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and setup
git clone <your-repo>
cd snapbudget
npm install
node src/db/migrate.js

# Set WEBHOOK_URL to your domain in .env
# NODE_ENV=production

# Run with PM2
npm install -g pm2
pm2 start src/index.js --name snapbudget
pm2 save
pm2 startup
```

### Set up HTTPS (required for webhooks)

```bash
# With nginx + certbot
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Nginx config:
```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    location /webhook {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }

    location /api {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
}
```

---

## API Reference (Mini App)

All endpoints require `x-telegram-init-data` header (set automatically by Telegram Mini App SDK).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/receipt/:id` | Get receipt + items + members |
| POST | `/api/receipt/:id/assignments` | Save item→user assignments |
| POST | `/api/receipt/:id/confirm` | Finalize and create splits |
| GET | `/api/group/:id/balances` | Simplified debt graph |
| GET | `/api/group/:id/receipts` | Recent receipts |
| GET | `/api/user/stats` | Monthly stats for current user |
| GET | `/api/user/balances` | Debts across all groups |

---

## Bot Commands Reference

| Command | Where | Description |
|---------|-------|-------------|
| 📸 Photo | Group | Scan receipt → auto OCR → split |
| `/split 1200` | Group | Split ₹1200 equally |
| `/balances` | Group | See simplified debts |
| `/stats` | Group | Group spending stats |
| `/mystats` | DM | Personal monthly summary |
| `/mybalances` | DM | Your debts across groups |

---

## How Receipt Flow Works

```
User sends photo in group
         │
         ▼
Bot downloads image from Telegram
         │
         ▼
Google Vision OCR → raw text
         │
         ▼
parseReceiptText() → structured items
         │
         ▼
Claude API → category tag
         │
         ▼
Receipt saved to SQLite DB
         │
         ▼
Bot replies with item list + Mini App button
         │
    ┌────┴────┐
    │         │
"Split Equal" "Open Mini App"
    │         │
    │    User assigns items → confirms
    │         │
    └────┬────┘
         │
         ▼
calculateSplits() → debt entries
         │
         ▼
Bot posts split card with [Pay] buttons
         │
         ▼
Members tap Pay → Telegram invoice
         │
         ▼
successful_payment → markSplitPaid()
         │
         ▼
Split card auto-updates ✅
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Bot framework | [Telegraf](https://telegraf.js.org/) v4 |
| HTTP server | Express.js |
| Database | SQLite (better-sqlite3) |
| OCR | Google Cloud Vision API |
| AI categorization | Claude Haiku (claude-haiku-4-5) |
| Payments | Telegram Payments API |
| Language | Node.js ESM |

---

## Connecting the Mini App

In your Mini App (the React frontend), initialize the Telegram Web App SDK:

```html
<script src="https://telegram.org/js/telegram-web-app.js"></script>
```

```javascript
const tg = window.Telegram.WebApp;
tg.ready();

// Get init data for API auth
const initData = tg.initData;

// Make API calls
const response = await fetch(`${API_URL}/api/receipt/${receiptId}`, {
  headers: { 'x-telegram-init-data': initData }
});
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | ✅ | From @BotFather |
| `MINI_APP_URL` | ✅ | Where your React app is hosted |
| `WEBHOOK_URL` | Production | Your server's public HTTPS URL |
| `GOOGLE_VISION_API_KEY` | Recommended | For OCR (or use Tesseract) |
| `ANTHROPIC_API_KEY` | Optional | For AI categorization |
| `PAYMENT_PROVIDER_TOKEN` | Optional | For in-app payments |
| `DB_PATH` | Optional | SQLite file path (default: ./data/snapbudget.db) |
