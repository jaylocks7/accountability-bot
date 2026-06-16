import { handleWebhook } from '../handlers/webhook.js';
import dotenv from 'dotenv';
import { APIGatewayProxyEvent } from 'aws-lambda';

dotenv.config();

function makeMockEvent(text: string): APIGatewayProxyEvent {
    return {
        body: JSON.stringify({
            message: {
                text,
                chat: { id: process.env.YOUR_TELEGRAM_CHAT_ID }
            }
        }),
        requestContext: {}
    } as APIGatewayProxyEvent;
}

async function runTest(name: string, text: string) {
    console.log(`\n--- ${name} ---`);
    console.log(`User message: "${text}"`);
    try {
        await handleWebhook(makeMockEvent(text));
        console.log(`PASS: ${name}`);
    } catch (err) {
        console.error(`FAIL: ${name}`, err);
    }
}

async function testCompleteTasks() {
    await runTest("complete_tasks", "I finished my workout");
}

async function testAddTasks() {
    await runTest("add_tasks", "Add buy groceries and call dentist to my list");
}

// --- Run all tests ---
(async () => {
    await testCompleteTasks();
    await testAddTasks();
})();
