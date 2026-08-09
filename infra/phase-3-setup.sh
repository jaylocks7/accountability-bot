#!/usr/bin/env bash
# Phase-3 AWS infrastructure setup — DO NOT EXECUTE AUTOMATICALLY.
# Review each command, fill in <placeholders>, then run manually.
#
# NOTE: Tables (Users/Tasks/Messages), SQS queues, event-source mapping, IAM,
# EventBridge, Lambda env vars, webhook re-registration, and CloudWatch alarm
# are ALL defined in infra/phase-1-setup.sh. Run that first.
#
# This script covers the Phase-3-specific actions that require the new
# Lambda code to be deployed before they can be verified/activated.
#
# Region: us-east-2

set -euo pipefail
REGION="us-east-2"

# ── 1. Deploy updated Lambda code ─────────────────────────────────────────────
# Build and zip, then update the function:
#
#   npm run build
#   zip -r lambda-deployment.zip dist/ node_modules/
#   aws lambda update-function-code \
#     --region "$REGION" \
#     --function-name task-bot \
#     --zip-file fileb://lambda-deployment.zip

# ── 2. Verify SQS queues exist (created in phase-1-setup.sh) ─────────────────

aws sqs get-queue-url \
  --region "$REGION" \
  --queue-name task-bot-checkins-dlq

aws sqs get-queue-url \
  --region "$REGION" \
  --queue-name task-bot-checkins

# ── 3. Verify event-source mapping exists (created in phase-1-setup.sh) ───────

aws lambda list-event-source-mappings \
  --region "$REGION" \
  --function-name task-bot \
  --query "EventSourceMappings[?contains(EventSourceArn, 'task-bot-checkins')]"

# ── 4. Confirm Lambda env vars include the check-in queue URL ─────────────────
# If not already set via phase-1-setup.sh, run:
#
# QUEUE_URL=$(aws sqs get-queue-url \
#   --region "$REGION" \
#   --queue-name task-bot-checkins \
#   --query QueueUrl --output text)
#
# aws lambda update-function-configuration \
#   --region "$REGION" \
#   --function-name task-bot \
#   --environment "Variables={
#     ANTHROPIC_API_KEY=<existing>,
#     TELEGRAM_BOT_TOKEN=<existing>,
#     TELEGRAM_WEBHOOK_SECRET=<your-secret>,
#     CHECKIN_QUEUE_URL=$QUEUE_URL,
#     USERS_TABLE=Users,
#     TASKS_TABLE=Tasks,
#     MESSAGES_TABLE=Messages
#   }"

# ── 5. Smoke-test dispatcher (tick) with check-ins DISABLED ──────────────────
# Invoking the tick when no users have checkInsEnabled should enqueue nothing.
# Safe to run at any time.
#
# aws lambda invoke \
#   --region "$REGION" \
#   --function-name task-bot \
#   --payload '{"checkInType":"tick"}' \
#   --cli-binary-format raw-in-base64-out \
#   /tmp/tick-response.json && cat /tmp/tick-response.json

# ── 6. Smoke-test worker via direct SQS send ─────────────────────────────────
# Replace <CHAT_ID> and <DATE> with a real chatId and today's local date (YYYY-MM-DD).
# The user must have checkInsEnabled=true in the Users table.
#
# QUEUE_URL=$(aws sqs get-queue-url \
#   --region "$REGION" \
#   --queue-name task-bot-checkins \
#   --query QueueUrl --output text)
#
# aws sqs send-message \
#   --region "$REGION" \
#   --queue-url "$QUEUE_URL" \
#   --message-body '{"chatId":"<CHAT_ID>","checkInType":"morning","localDate":"<DATE>"}'

# ── 7. Enable EventBridge tick (optional — bot works without it) ──────────────
# The task-bot-tick rule is created DISABLED in phase-1-setup.sh.
# Enable only when you're ready for live scheduled check-ins:
#
# aws events enable-rule \
#   --region "$REGION" \
#   --name task-bot-tick

# ── 8. CloudWatch alarm — DLQ not empty (created in phase-1-setup.sh) ─────────
# Verify it exists:
#
# aws cloudwatch describe-alarms \
#   --region "$REGION" \
#   --alarm-names task-bot-dlq-not-empty
