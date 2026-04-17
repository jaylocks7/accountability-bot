# You Got This Bot

## Idea

I have to-do lists I make for myself every night for the next day. They sit as a text to myself in the Signal App on my phone. When the next day arrives, I go to the text in my phone and delete any tasks I accomplish as I complete them. However the text can easily get buried under other notes I make throughout the day, and if I have any leftover tasks at the day's end I have to add them (if I remember) to the next list.

I want a lightweight, dedicated place for my to-do list tasks for the day. I also want to keep track of how long I've had a task for, and have it prioritized in my to-do list. I thrive in environments of accountability, so the idea of an AI-coach came to mind.

## What It Does

An AI accountability bot that:
- Gathers your to-do list tasks the night before (9 PM PT)
- Aggregates leftover tasks from previous days if you choose
- Remembers how long tasks remain undone and prioritizes accordingly
- Checks in throughout the day to remind and encourage you (9 AM, 6 PM PT)
- Provides your current task list on request
- Asks thoughtful questions about long-standing tasks ("Why is this important?" "Can we break this down?")
- Lets you clear or delete tasks
- Interfaces via Telegram messages
- Is friendly yet firm
- Celebrates your wins and gives you space after completing tasks

## Tech Stack

- **AI**: Claude Opus 4.5 (Anthropic API)
- **Messaging**: Telegram Bot API
- **Backend**: AWS Lambda (Node.js 20.x)
- **Database**: AWS DynamoDB
- **Scheduling**: AWS EventBridge (cron rules)
- **API**: AWS API Gateway (webhook endpoint)

## Project Structure

```
task-bot/
├── src/
│   ├── index.ts                    # Main Lambda handler (routes events)
│   ├── handlers/
│   │   ├── checkIn.ts              # Scheduled check-ins (9 AM, 6 PM, 9 PM)
│   │   └── webhook.ts              # Incoming Telegram messages [✅ Complete]
│   ├── services/
│   │   ├── telegram.ts             # Telegram bot wrapper [✅ Complete]
│   │   └── dynamodb.ts             # Database operations [✅ Complete]
│   └── test/
│       └── test-webhook.ts         # Manual webhook test with mock event
├── dist/                           # Compiled JS output (git-ignored)
├── package.json
├── tsconfig.json
├── .env                            # Local secrets (git-ignored)
├── .env.example                    # Environment variable template
└── README.md
```

## Setup

### 1. Prerequisites
- Node.js 20.x
- AWS account (free tier sufficient)
- Telegram account
- Anthropic API key

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Variables
Copy `.env.example` to `.env` and fill in your credentials:
```bash
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
YOUR_TELEGRAM_CHAT_ID=your_numeric_chat_id
ANTHROPIC_API_KEY=your_anthropic_api_key
DYNAMODB_TABLE_NAME=CheckIns
AWS_REGION=us-east-1
```

### 4. Create Telegram Bot
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow prompts
3. Save the bot token to `.env`
4. Get your chat ID by messaging [@userinfobot](https://t.me/userinfobot)

### 5. AWS Setup (After Code is Complete)
1. Create DynamoDB table named "CheckIns" with partition key "id" (String)
2. Deploy Lambda function (zip and upload via AWS Console/CLI)
3. Create API Gateway HTTP endpoint, integrate with Lambda
4. Set Telegram webhook: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<API_GATEWAY_URL>`
5. Create 3 EventBridge rules with cron expressions:
   - Morning (9 AM PT): `cron(0 17 * * ? *)`
   - Afternoon (6 PM PT): `cron(0 2 * * ? *)`
   - Evening (9 PM PT): `cron(0 5 * * ? *)`
6. Add environment variables to Lambda configuration

## How It Works

### Daily Flow
1. **9 PM**: Bot asks for tomorrow's tasks + option to carry over incomplete tasks
2. **9 AM**: Personalized morning check-in based on your task list
3. **6 PM**: Afternoon progress check
4. **Anytime**: Report completions → bot celebrates and shows remaining tasks

### Data Storage
Tasks are stored in DynamoDB (`CheckIns` table) with this structure:
```typescript
{
  date: string,            // PK — YYYY-MM-DD (Pacific time)
  timestamp: number,       // SK — Unix timestamp ms
  type: string,            // "task_list" | "user_input" | "ai_output"
  tasks: [                 // Task array (for task_list type)
    {
      text: string,
      completed: boolean,
      priority: boolean
    }
  ],
  message?: string         // Message text (for user_input / ai_output types)
}
```

## Development Status

### ✅ Complete
- Core services (Telegram, DynamoDB)
- Main Lambda router (`src/index.ts`)
- Webhook handler (`src/handlers/webhook.ts`) — tested with manual mock event
- Tests for webhook, Telegram, and DynamoDB (`src/test/`)

### 🚧 In Progress
- Check-in handlers (`src/handlers/checkIn.ts`)
- End-to-end testing from Telegram directly

### 📋 Todo
- Deploy to AWS Lambda
- Set Telegram webhook URL to API Gateway endpoint
- End-to-end testing via real Telegram messages

## Testing Locally

```bash
# Compile TypeScript
npx tsc

# Run webhook handler with mock event (tests DynamoDB + Claude + Telegram)
node dist/test/test-webhook.js
```

## Future Ideas

- Task priority scoring based on age
- Weekly review summaries
- Natural language task parsing improvements
- Multi-user support (would require server running 24/7)
- Custom check-in schedules per user

## Cost Estimate

Using AWS free tier:
- Lambda: Free (1M requests/month)
- DynamoDB: Free (25GB storage, 25 WCU/RCU)
- API Gateway: Free (1M requests/month)
- Claude API: ~$2.70/month (6 calls/day with Opus 4.5)

**Total: ~$3/month**

## License

Personal project - use as you wish!
