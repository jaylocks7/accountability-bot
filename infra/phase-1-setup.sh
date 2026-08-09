#!/usr/bin/env bash
# Phase-1 AWS infrastructure setup — DO NOT EXECUTE AUTOMATICALLY.
# Review each command, fill in <placeholders>, then run manually.
# Region: us-east-2

set -euo pipefail
REGION="us-east-2"

# ── 1. Create DynamoDB tables (on-demand billing) ─────────────────────────────

# Users table — PK chatId (S), no SK
aws dynamodb create-table \
  --region "$REGION" \
  --table-name Users \
  --attribute-definitions AttributeName=chatId,AttributeType=S \
  --key-schema AttributeName=chatId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# Tasks table — PK chatId (S), SK sk (S)
aws dynamodb create-table \
  --region "$REGION" \
  --table-name Tasks \
  --attribute-definitions \
      AttributeName=chatId,AttributeType=S \
      AttributeName=sk,AttributeType=S \
  --key-schema \
      AttributeName=chatId,KeyType=HASH \
      AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

# Messages table — PK chatId (S), SK sk (S), TTL on expiresAt
aws dynamodb create-table \
  --region "$REGION" \
  --table-name Messages \
  --attribute-definitions \
      AttributeName=chatId,AttributeType=S \
      AttributeName=sk,AttributeType=S \
  --key-schema \
      AttributeName=chatId,KeyType=HASH \
      AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

# Enable TTL on Messages
aws dynamodb update-time-to-live \
  --region "$REGION" \
  --table-name Messages \
  --time-to-live-specification "Enabled=true,AttributeName=expiresAt"

# ── 2. SQS queues ─────────────────────────────────────────────────────────────

# DLQ first (needed for redrive policy ARN)
DLQ_URL=$(aws sqs create-queue \
  --region "$REGION" \
  --queue-name task-bot-checkins-dlq \
  --query QueueUrl --output text)

DLQ_ARN=$(aws sqs get-queue-attributes \
  --region "$REGION" \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# Main queue with redrive, VisibilityTimeout 90s
aws sqs create-queue \
  --region "$REGION" \
  --queue-name task-bot-checkins \
  --attributes "{\"VisibilityTimeout\":\"90\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}"

# ── 3. Lambda event-source mapping (queue → task-bot Lambda) ─────────────────
# Replace <LAMBDA_ARN> with the task-bot Lambda ARN.
QUEUE_URL=$(aws sqs get-queue-url \
  --region "$REGION" \
  --queue-name task-bot-checkins \
  --query QueueUrl --output text)

QUEUE_ARN=$(aws sqs get-queue-attributes \
  --region "$REGION" \
  --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

aws lambda create-event-source-mapping \
  --region "$REGION" \
  --function-name task-bot \
  --event-source-arn "$QUEUE_ARN" \
  --batch-size 10 \
  --function-response-types ReportBatchItemFailures

# ── 4. IAM — update task-bot-lambda-role inline policy ───────────────────────
# Replace <ACCOUNT_ID> with your AWS account ID.
# This replaces any existing CheckIns table permissions.
# ACCOUNT_ID=<ACCOUNT_ID>
#
# aws iam put-role-policy \
#   --role-name task-bot-lambda-role \
#   --policy-name task-bot-dynamo-sqs \
#   --policy-document "{
#     \"Version\": \"2012-10-17\",
#     \"Statement\": [
#       {
#         \"Effect\": \"Allow\",
#         \"Action\": [
#           \"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\",
#           \"dynamodb:DeleteItem\",\"dynamodb:Query\",\"dynamodb:Scan\",
#           \"dynamodb:BatchWriteItem\"
#         ],
#         \"Resource\": [
#           \"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/Users\",
#           \"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/Tasks\",
#           \"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/Messages\"
#         ]
#       },
#       {
#         \"Effect\": \"Allow\",
#         \"Action\": [\"sqs:SendMessage\",\"sqs:SendMessageBatch\"],
#         \"Resource\": \"$QUEUE_ARN\"
#       },
#       {
#         \"Effect\": \"Allow\",
#         \"Action\": [\"sqs:ReceiveMessage\",\"sqs:DeleteMessage\",\"sqs:GetQueueAttributes\"],
#         \"Resource\": \"$QUEUE_ARN\"
#       }
#     ]
#   }"

# ── 5. EventBridge — replace morning/afternoon/evening with single tick rule ──
# Delete old rules (rule must have targets removed first):
# aws events remove-targets --region "$REGION" --rule task-bot-morning --ids 1
# aws events delete-rule   --region "$REGION" --name task-bot-morning
# aws events remove-targets --region "$REGION" --rule task-bot-afternoon --ids 1
# aws events delete-rule   --region "$REGION" --name task-bot-afternoon
# aws events remove-targets --region "$REGION" --rule task-bot-evening --ids 1
# aws events delete-rule   --region "$REGION" --name task-bot-evening

# Create hourly tick (disabled by default — safe to leave off per design constraint):
# aws events put-rule \
#   --region "$REGION" \
#   --name task-bot-tick \
#   --schedule-expression "cron(0 * * * ? *)" \
#   --state DISABLED
#
# aws events put-targets \
#   --region "$REGION" \
#   --rule task-bot-tick \
#   --targets "[{\"Id\":\"1\",\"Arn\":\"<LAMBDA_ARN>\",\"Input\":\"{\\\"checkInType\\\":\\\"tick\\\"}\",\"RoleArn\":\"<SCHEDULER_ROLE_ARN>\"}]"

# ── 6. Lambda env vars ────────────────────────────────────────────────────────
# Add new vars, remove old ones. Replace <QUEUE_URL> with actual URL.
# aws lambda update-function-configuration \
#   --region "$REGION" \
#   --function-name task-bot \
#   --environment "Variables={
#     ANTHROPIC_API_KEY=<existing>,
#     TELEGRAM_BOT_TOKEN=<existing>,
#     TELEGRAM_WEBHOOK_SECRET=<generate a random string>,
#     CHECKIN_QUEUE_URL=<QUEUE_URL>,
#     USERS_TABLE=Users,
#     TASKS_TABLE=Tasks,
#     MESSAGES_TABLE=Messages
#   }"
# NOTE: Remove YOUR_TELEGRAM_CHAT_ID and DYNAMODB_TABLE_NAME from the above.

# ── 7. Re-register Telegram webhook with secret token ────────────────────────
# curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<API_GATEWAY_URL>&secret_token=<TELEGRAM_WEBHOOK_SECRET>"

# ── 8. CloudWatch alarm — DLQ not empty ──────────────────────────────────────
# aws cloudwatch put-metric-alarm \
#   --region "$REGION" \
#   --alarm-name task-bot-dlq-not-empty \
#   --metric-name ApproximateNumberOfMessagesVisible \
#   --namespace AWS/SQS \
#   --dimensions "Name=QueueName,Value=task-bot-checkins-dlq" \
#   --statistic Sum \
#   --period 300 \
#   --evaluation-periods 1 \
#   --threshold 1 \
#   --comparison-operator GreaterThanOrEqualToThreshold \
#   --alarm-actions <SNS_TOPIC_ARN>
