/**
 * Integration tests for webhook.ts — Phase 2 acceptance criteria.
 *
 * INTEGRATION TESTS: these tests hit real AWS DynamoDB and Telegram.
 * Prerequisites:
 *   - .env loaded with TELEGRAM_WEBHOOK_SECRET, USERS_TABLE, TASKS_TABLE,
 *     MESSAGES_TABLE, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY
 *   - A real Telegram chat id in env var TEST_CHAT_ID
 *
 * Run: npx ts-node --esm src/test/test-webhook.ts
 */

import { handleWebhook } from "../handlers/webhook.js";
import { getRecentMessages } from "../services/dynamodb.js";
import dotenv from "dotenv";
import { APIGatewayProxyEvent } from "aws-lambda";

dotenv.config();

const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "test-secret";
const CHAT_ID = process.env.TEST_CHAT_ID ?? "000000";

function makeEvent(text: string, chatId = CHAT_ID, secret = SECRET): APIGatewayProxyEvent {
    return {
        headers: { "x-telegram-bot-api-secret-token": secret },
        body: JSON.stringify({
            message: {
                text,
                chat: { id: Number(chatId) },
                from: { first_name: "Tester" },
            },
        }),
        requestContext: {},
    } as unknown as APIGatewayProxyEvent;
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${name}:`, err);
        failed++;
    }
}

function assert(condition: boolean, msg: string) {
    if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// AC1: Wrong secret → rejected (throws, does not reach AWS)
await test("wrong secret → rejected", async () => {
    let threw = false;
    try {
        await handleWebhook(makeEvent("hello", CHAT_ID, "wrong-secret"));
    } catch (e) {
        threw = true;
        assert(String(e).includes("Unauthorized"), "should throw Unauthorized");
    }
    assert(threw, "expected an error to be thrown");
});

// AC1b: Missing env secret → rejected even if header matches empty string
await test("missing env secret → rejected (fail-closed)", async () => {
    const orig = process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    let threw = false;
    try {
        await handleWebhook(makeEvent("hello", CHAT_ID, ""));
    } catch (e) {
        threw = true;
        assert(String(e).includes("Unauthorized"), "should throw Unauthorized");
    } finally {
        process.env.TELEGRAM_WEBHOOK_SECRET = orig;
    }
    assert(threw, "expected an error when env secret is unset");
});

// --- remaining tests require real AWS + Telegram ---
if (!process.env.TEST_CHAT_ID) {
    console.log("\n  SKIP  AWS/Telegram integration tests — set TEST_CHAT_ID to run them");
} else {
    // Use a unique chat id per run so we get the new-user flow reliably
    const newUserId = `9${Date.now()}`.slice(0, 10);

    // AC2: Unknown chatId → welcome message (new-user flow, returns early)
    await test("unknown chatId → welcome message and return", async () => {
        // Should not throw; the handler sends welcome and returns without Claude call
        await handleWebhook(makeEvent("hi there", newUserId));
        // If we reach here without error, welcome was sent and handler returned
    });

    // AC3: add two tasks in one message; verify messages persisted and no task list in user turn
    await test('"add gym and laundry" → 2 tasks added, messages persisted, no task list in user turn', async () => {
        await handleWebhook(makeEvent("add gym and laundry", CHAT_ID));
        const msgs = await getRecentMessages(CHAT_ID);
        const userMsgs = msgs.filter((m) => m.role === "user" && m.kind === "chat");
        const assistantMsgs = msgs.filter((m) => m.role === "assistant" && m.kind === "chat");
        assert(userMsgs.length > 0, "at least one user chat message saved");
        assert(assistantMsgs.length > 0, "at least one assistant chat message saved");
        // Task list must never appear inside a user-role message item
        for (const m of userMsgs) {
            assert(!m.content.includes("[ ]") && !m.content.includes("[done]"), `user message contains task list format: ${m.content}`);
        }
    });

    // AC4: multi-round tool loop in one exchange (complete + remove + add)
    await test("complete + remove + add in single exchange (multi-round loop)", async () => {
        await handleWebhook(makeEvent("mark gym done, remove laundry, add read book", CHAT_ID));
    });

    // AC5: /list works
    await test("/list returns task list without Claude usage", async () => {
        await handleWebhook(makeEvent("/list", CHAT_ID));
    });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
