# Accountability Bot

## Idea

I have to-do lists I make for myself every night for the next day. They sit as a text to myself in the Signal App on my phone. When the next day arrives, I go to the text in my phone and delete any tasks I accomplish as I complete them. However the text can easily get buried under other notes I make throughout the day, and if I have any leftover tasks at the day's end I have to add them (if I remember) to the next list.

I want a lightweight, dedicated place for my to-do list tasks for the day. I thrive in environments of accountability, so the idea of an AI-coach came to mind.

## Write-up Link

https://docs.google.com/document/d/17B3Z3SAH23Xhk0OQro4uNtT3blvqxdqAQUJTl5Nz_HM/edit?usp=sharing

## What It Does

An AI accountability bot that:
- Gathers your to-do list tasks the night before (11 PM PT)
- Automatically carries over incomplete tasks to the next day (configurable)
- Checks in throughout the day to remind and encourage you (9 AM, 6 PM PT)
- Provides your current task list on request
- Lets you add, remove, complete, un-complete tasks
- Lets you set or unset task priority
- Goes to sleep after 6 missed check-ins with no response, wakes on your next message
- Interfaces via Telegram messages
- Is friendly yet firm, celebrates completions

## Tech Stack

- **AI**: Claude Sonnet 4.6 (Anthropic API)
- **Messaging**: Telegram Bot API
- **Backend**: AWS Lambda (Node.js 20.x)
- **Database**: AWS DynamoDB
- **Scheduling**: AWS EventBridge Schedules
- **API**: AWS API Gateway (HTTP API)
- **Logging**: AWS CloudWatch Logs

## Systems Architecture

```
                  ┌───────────────────────┐
                  │      EventBridge      │
                  │   9AM / 6PM / 11PM PT │
                  └──────────┬────────────┘
                             │ checkInType event
                             ▼
┌──────────┐  webhook POST  ┌─────────────┐  invoke  ┌──────────────────────────┐
│ Telegram │───────────────▶│ API Gateway │─────────▶│       AWS Lambda         │
│  (user)  │◀──────────────────────────────── reply ─│  webhook / checkIn       │
└──────────┘                └─────────────┘          └────────────┬─────────────┘
                                                                   │
                    ┌──────────────────────────────────────────────┼──────────────────────┐
                    │ tool calls                                   │ messages             │ logs
                    ▼                                              ▼                      ▼
          ┌──────────────────┐                        ┌──────────────────┐  ┌──────────────────┐
          │    DynamoDB      │                        │  Anthropic API   │  │   CloudWatch     │
          │   (CheckIns)     │                        │   (Claude 4.6)   │  │     Logs         │
          └──────────────────┘                        └──────────────────┘  └──────────────────┘
```

## Project Structure

```
task-bot/
├── src/
│   ├── index.ts                    # Lambda handler — routes events by type
│   ├── handlers/
│   │   ├── checkIn.ts              # Scheduled check-ins (9 AM, 6 PM, 11 PM PT)
│   │   └── webhook.ts              # Incoming Telegram messages + tool execution
│   ├── services/
│   │   ├── telegram.ts             # Telegram Bot API wrapper
│   │   └── dynamodb.ts             # DynamoDB read/write/update operations
│   └── test/
│       ├── test-webhook.ts         # Manual webhook test with mock event
│       ├── test-telegram.ts        # Telegram service test
│       └── test-dynamodb.ts        # DynamoDB service test
├── dist/                           # Compiled JS output (git-ignored)
├── package.json
├── tsconfig.json
├── .env                            # Local secrets (git-ignored)
└── README.md
```

## Features

### Scheduled Check-ins
| Time (PT) | Behavior |
|---|---|
| 9 AM | Morning check-in — energizing message referencing today's task list |
| 6 PM | Afternoon check-in — celebrates completed tasks, pushes on remaining |
| 11 PM | Evening prompt — acknowledges the day, asks for tomorrow's tasks |

### Task Management (via Telegram)
| What you say | What happens |
|---|---|
| "I finished X" | Marks task complete, Claude celebrates |
| "Add X, Y, Z to my list" | Adds tasks |
| "Remove task 2" | Removes by index |
| "Mark task 1 as not done" | Un-completes a task |
| "Make task 0 priority" | Sets priority flag |
| "What's on my list?" | Claude reads from context, no tool call needed |
| "Turn off auto-rollover" | Disables next-day carryover of incomplete tasks |

### Inactivity Sleep Mode
After 6 consecutive check-ins with no user response, the bot sends a sleep message and stops initiating. Any message from the user resets the counter and resumes normal check-ins.

### Task Rollover
At the 11 PM check-in, incomplete tasks are automatically carried over to tomorrow's list. This defaults to OFF and can be toggled by the user at any time ("can you turn on task rollover?")

## Data Storage

Tasks are stored in DynamoDB (`CheckIns` table, region: `us-east-2`):

```typescript
// Task list record
{
  date: string,       // PK — YYYY-MM-DD (Pacific time)
  timestamp: number,  // SK — Unix timestamp ms
  type: "task_list",
  tasks: [
    { text: string, completed: boolean, priority: boolean }
  ]
}

// Special records (fixed keys)
{ date: "session",  timestamp: 0 }  // evening session flag
{ date: "settings", timestamp: 0 }  // autoRollover, missedCheckIns
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
YOUR_TELEGRAM_CHAT_ID=your_numeric_chat_id
ANTHROPIC_API_KEY=your_anthropic_api_key
DYNAMODB_TABLE_NAME=CheckIns
AWS_REGION=us-east-2
```

### 4. Create Telegram Bot
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow prompts
3. Save the bot token
4. Get your chat ID by messaging [@userinfobot](https://t.me/userinfobot)

### 5. AWS Setup
1. **DynamoDB** — create table `CheckIns`, partition key `date` (String), sort key `timestamp` (Number), region `us-east-2`
2. **IAM** — create `task-bot-lambda-role` with `AWSLambdaBasicExecutionRole` + DynamoDB inline policy
3. **Lambda** — Node.js 20.x, handler `dist/index.handler`, timeout 30s, attach `task-bot-lambda-role`, set env vars
4. **API Gateway** — HTTP API, `POST /` route integrated with Lambda
5. **Telegram webhook** — `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<API_GATEWAY_URL>`
6. **EventBridge** — 3 schedules targeting Lambda with `task-bot-scheduler-role`:

| Schedule | Cron (UTC) | Payload |
|---|---|---|
| `task-bot-morning` | `0 17 * * ? *` | `{"checkInType":"morning"}` |
| `task-bot-afternoon` | `0 2 * * ? *` | `{"checkInType":"afternoon"}` |
| `task-bot-evening` | `0 7 * * ? *` | `{"checkInType":"evening"}` |

### 6. Deploy
```bash
rm -rf dist && npx tsc && rm -f lambda-deployment.zip && \
zip -r lambda-deployment.zip dist/ node_modules/ package.json && \
aws lambda update-function-code --function-name task-bot \
  --zip-file fileb://lambda-deployment.zip --region us-east-2
```

### 7. Start Using
Message your bot on Telegram. It will create today's task list automatically on first message.

## Testing Locally

```bash
# Compile TypeScript
npx tsc

# Run webhook handler with mock event (tests DynamoDB + Claude + Telegram)
node dist/test/test-webhook.js
```

## License

Personal project - use as you wish!
