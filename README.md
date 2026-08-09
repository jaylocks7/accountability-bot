# Accountability Bot

## Idea

I have to-do lists I make for myself every night for the next day. They sit as a text to myself in the Signal App on my phone. When the next day arrives, I go to the text in my phone and delete any tasks I accomplish as I complete them. However the text can easily get buried under other notes I make throughout the day, and if I have any leftover tasks at the day's end I have to add them (if I remember) to the next list.

I want a lightweight, dedicated place for my to-do list tasks for the day. I thrive in environments of accountability, so the idea of an AI-coach came to mind.

## Write-up Link

https://docs.google.com/document/d/17B3Z3SAH23Xhk0OQro4uNtT3blvqxdqAQUJTl5Nz_HM/edit?usp=sharing

## What It Does

An AI accountability bot that:
- Gathers your to-do list tasks the night before
- Automatically carries over incomplete tasks to the next day (configurable)
- Checks in throughout the day to remind and encourage you (configurable hours, per-user timezone)
- Provides your current task list on request
- Lets you add, remove, complete, un-complete tasks
- Lets you set or unset task priority
- Goes to sleep after 6 missed check-ins with no response, wakes on your next message
- Interfaces via Telegram messages
- Is friendly yet firm, celebrates completions
- Supports multiple users, each with their own timezone and preferences

## Tech Stack

- **AI**: Claude Sonnet 4.6 (Anthropic API)
- **Messaging**: Telegram Bot API
- **Backend**: AWS Lambda (Node.js 20.x)
- **Database**: AWS DynamoDB (3 tables)
- **Scheduling**: AWS EventBridge Schedules + SQS
- **API**: AWS API Gateway (HTTP API)
- **Logging**: AWS CloudWatch Logs

## Systems Architecture

```
                  ┌─────────────────────────────────────────────┐
                  │  EventBridge (hourly tick)                   │
                  │  cron(0 * * * ? *), payload {"checkInType":"tick"} │
                  └──────────────────┬──────────────────────────┘
                                     │
                                     ▼
┌──────────┐  webhook POST  ┌─────────────┐  invoke  ┌──────────────────────────┐
│ Telegram │───────────────▶│ API Gateway │─────────▶│       AWS Lambda         │
│  (user)  │◀──────────────────────────────── reply ─│  webhook / dispatcher /  │
└──────────┘                └─────────────┘          │  check-in worker         │
                                                      └────────────┬─────────────┘
                                                                   │ dispatcher enqueues
                                                                   ▼
                                                      ┌──────────────────────────┐
                                                      │    SQS task-bot-checkins │
                                                      │    (DLQ: *-dlq, max 3)   │
                                                      └────────────┬─────────────┘
                                                                   │ SQS event source
                                                                   ▼
                    ┌──────────────────────────────────────────────┼──────────────────────┐
                    │ tool calls                                   │ messages             │ logs
                    ▼                                              ▼                      ▼
          ┌──────────────────┐                        ┌──────────────────┐  ┌──────────────────┐
          │    DynamoDB      │                        │  Anthropic API   │  │   CloudWatch     │
          │ Users/Tasks/     │                        │   (Claude 4.6)   │  │     Logs         │
          │ Messages         │                        └──────────────────┘  └──────────────────┘
          └──────────────────┘
```

## Project Structure

```
task-bot/
├── src/
│   ├── index.ts                    # Lambda handler — routes events by type
│   ├── handlers/
│   │   ├── checkIn.ts              # Dispatcher + SQS worker for scheduled check-ins
│   │   └── webhook.ts              # Incoming Telegram messages + tool execution
│   ├── services/
│   │   ├── telegram.ts             # Telegram Bot API wrapper
│   │   ├── dynamodb.ts             # DynamoDB read/write/update operations
│   │   ├── dates.ts                # Timezone-aware date helpers
│   │   └── format.ts               # Shared task list formatter
│   └── test/
│       ├── test-webhook.ts         # Manual webhook test with mock event
│       ├── test-telegram.ts        # Telegram service test
│       └── test-dynamodb.ts        # DynamoDB service test
├── dist/                           # Compiled JS output (git-ignored)
├── infra/                          # AWS CLI setup scripts (review before running)
├── package.json
├── tsconfig.json
├── .env                            # Local secrets (git-ignored)
└── README.md
```

## Features

### Scheduled Check-ins
| Time | Behavior |
|---|---|
| Morning (configurable per user) | Morning check-in — energizing message referencing today's task list |
| Afternoon (configurable per user) | Afternoon check-in — celebrates completed tasks, pushes on remaining |
| Evening (configurable per user) | Evening prompt — acknowledges the day, offers rollover |

### Task Management (via Telegram)
| What you say | What happens |
|---|---|
| "I finished X" | Marks task complete, Claude celebrates |
| "Add X, Y, Z to my list" | Adds tasks |
| "Remove task 2" | Removes by index |
| "Mark task 1 as not done" | Un-completes a task |
| "Make task 0 priority" | Sets priority flag |
| "/list" | Returns current task list immediately |
| "Turn off auto-rollover" | Disables next-day carryover of incomplete tasks |
| "I'm in Tokyo" | Sets timezone to Asia/Tokyo |

### Inactivity Sleep Mode
After 6 consecutive check-ins with no user response, the bot sends a sleep message and stops initiating. Any message from the user resets the counter and resumes normal check-ins.

### Task Rollover
Incomplete tasks roll over on your next webhook interaction (lazy day-init), not at the evening check-in. Defaults to OFF and can be toggled at any time.

## Data Storage

Three DynamoDB tables (region: `us-east-2`, all on-demand billing):

```typescript
// Users table — PK: chatId (String)
interface User {
  chatId: string;
  firstName: string;
  timezone: string;               // IANA, default "America/Los_Angeles"
  checkInHours: { morning: number; afternoon: number; evening: number };
  checkInsEnabled: boolean;
  autoRollover: boolean;
  missedCheckIns: number;
  eveningSession: boolean;
  status: "active" | "sleeping";
  lastCheckIns: { morning?: string; afternoon?: string; evening?: string };
  createdAt: number;
  lastResponseAt: number;
}

// Tasks table — PK: chatId (String), SK: sk = "${date}#${taskId}" (String)
interface Task {
  chatId: string;
  sk: string;
  taskId: string;                 // ULID
  date: string;                   // YYYY-MM-DD in user's timezone
  text: string;
  completed: boolean;
  priority: boolean;
  createdAt: number;
  completedAt?: number;
  rolledOverFrom?: string;
}

// Messages table — PK: chatId (String), SK: sk = "${epochMs}#${ulid}" (String)
// TTL attribute: expiresAt (epoch seconds, 30 days)
interface StoredMessage {
  chatId: string;
  sk: string;
  role: "user" | "assistant";
  kind: "chat" | "check_in" | "error";
  checkInType?: "morning" | "afternoon" | "evening";
  content: string;
  createdAt: number;
  expiresAt: number;
}
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
Set the following in `.env` (local) and Lambda configuration (deployed):
```bash
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_WEBHOOK_SECRET=a_random_secret_string
ANTHROPIC_API_KEY=your_anthropic_api_key
USERS_TABLE=Users
TASKS_TABLE=Tasks
MESSAGES_TABLE=Messages
CHECKIN_QUEUE_URL=https://sqs.us-east-2.amazonaws.com/<account>/task-bot-checkins
AWS_REGION=us-east-2
```

### 4. Create Telegram Bot
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow prompts
3. Save the bot token

### 5. AWS Setup
See `infra/` for CLI scripts. High-level steps:

1. **DynamoDB** — create three tables (all on-demand, `us-east-2`):
   - `Users`: PK `chatId` (String)
   - `Tasks`: PK `chatId` (String), SK `sk` (String)
   - `Messages`: PK `chatId` (String), SK `sk` (String); enable TTL on `expiresAt`

2. **SQS** — create `task-bot-checkins-dlq` (standard), then `task-bot-checkins` (standard, `VisibilityTimeout: 90`) with redrive policy pointing to the DLQ (`maxReceiveCount: 3`)

3. **IAM** — `task-bot-lambda-role` needs `AWSLambdaBasicExecutionRole` + inline policy:
   - DynamoDB: `GetItem, PutItem, UpdateItem, DeleteItem, Query, Scan, BatchWriteItem` on all three table ARNs
   - SQS: `SendMessage, SendMessageBatch` on the queue; `ReceiveMessage, DeleteMessage, GetQueueAttributes` (used by event source mapping)

4. **Lambda** — Node.js 20.x, handler `dist/index.handler`, timeout 30s, attach `task-bot-lambda-role`, set env vars above

5. **SQS event source mapping** — connect `task-bot-checkins` → `task-bot` Lambda, `BatchSize: 10`, `ReportBatchItemFailures: true`

6. **API Gateway** — HTTP API, `POST /` route integrated with Lambda

7. **Telegram webhook** — register with secret:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<API_GATEWAY_URL>&secret_token=<TELEGRAM_WEBHOOK_SECRET>
   ```

8. **EventBridge** (optional — bot works without it) — create `task-bot-tick`, `cron(0 * * * ? *)`, payload `{"checkInType":"tick"}`, targeting the Lambda with `task-bot-scheduler-role`

### 6. Deploy
```bash
rm -rf dist && npx tsc && rm -f lambda-deployment.zip && \
zip -r lambda-deployment.zip dist/ node_modules/ package.json && \
aws lambda update-function-code --function-name task-bot \
  --zip-file fileb://lambda-deployment.zip --region us-east-2
```

### 7. Start Using
Message your bot on Telegram. It will create your user profile automatically on first message.

## License

Personal project - use as you wish!
