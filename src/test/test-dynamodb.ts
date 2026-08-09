// Phase-1 integration tests for the new dynamodb service.
// Run: npx tsx src/test/test-dynamodb.ts
// Requires real AWS tables: Users, Tasks, Messages (us-east-2).

import assert from "assert";
import {
    createUser,
    getUser,
    addTasks,
    mutateTasks,
    removeTasks,
    rolloverTasks,
    saveMessage,
    getRecentMessages,
    claimCheckIn,
    resetRateLimit,
} from "../services/dynamodb.js";

// Unique chatId per run so parallel runs don't collide
const TEST_CHAT_ID = `test-${Date.now()}`;

async function testCreateAndGetUser() {
    console.log("\n[1] createUser / getUser roundtrip");
    const user = await createUser(TEST_CHAT_ID, "Alice");
    assert.strictEqual(user.chatId, TEST_CHAT_ID);
    assert.strictEqual(user.firstName, "Alice");
    assert.strictEqual(user.timezone, "America/Los_Angeles");
    assert.strictEqual(user.checkInsEnabled, false);
    assert.strictEqual(user.autoRollover, false);
    assert.strictEqual(user.missedCheckIns, 0);
    assert.strictEqual(user.status, "active");

    const fetched = await getUser(TEST_CHAT_ID);
    assert.ok(fetched, "getUser should return the created user");
    assert.strictEqual(fetched.chatId, TEST_CHAT_ID);
    assert.strictEqual(fetched.firstName, "Alice");
    console.log("  PASS");
}

async function testGetUserNull() {
    console.log("\n[2] getUser returns null for unknown chatId");
    const result = await getUser("nonexistent-chat-id-xyz-999");
    assert.strictEqual(result, null);
    console.log("  PASS");
}

async function testAddTasksAnd30Cap() {
    console.log("\n[3] addTasks + 30-cap enforcement");
    const date = "2000-01-01";

    // Add 28 tasks
    const batch1 = Array.from({ length: 28 }, (_, i) => `task-${i}`);
    const added = await addTasks(TEST_CHAT_ID, date, batch1);
    assert.strictEqual(added.length, 28, "should add 28 tasks");

    // Add 5 more — only 2 slots remain, so only 2 should be written
    const batch2 = ["extra-a", "extra-b", "extra-c", "extra-d", "extra-e"];
    const added2 = await addTasks(TEST_CHAT_ID, date, batch2);
    assert.strictEqual(added2.length, 2, "cap: only 2 of 5 should be accepted");

    // A third add should yield 0
    const added3 = await addTasks(TEST_CHAT_ID, date, ["overflow"]);
    assert.strictEqual(added3.length, 0, "cap: zero tasks when already at 30");
    console.log("  PASS");
}

async function testMutateByTaskId() {
    console.log("\n[4] mutateTasks — complete + priority by taskId");
    const date = "2000-01-02";
    const tasks = await addTasks(TEST_CHAT_ID, date, ["workout", "laundry", "groceries"]);
    assert.strictEqual(tasks.length, 3);

    const [t0, t1] = tasks;

    // complete t0, set priority on t1
    await mutateTasks(TEST_CHAT_ID, [t0.taskId], date, { completed: true });
    await mutateTasks(TEST_CHAT_ID, [t1.taskId], date, { priority: true });

    // fetch and verify
    const { getTasksForDate } = await import("../services/dynamodb.js");
    const fetched = await getTasksForDate(TEST_CHAT_ID, date);
    const ft0 = fetched.find((t) => t.taskId === t0.taskId)!;
    const ft1 = fetched.find((t) => t.taskId === t1.taskId)!;

    assert.ok(ft0.completed, "t0 should be completed");
    assert.ok(ft0.completedAt, "t0 should have completedAt timestamp");
    assert.ok(ft1.priority, "t1 should be priority");
    assert.ok(!ft1.completed, "t1 should NOT be completed");

    // uncomplete t0 — completedAt should be removed
    await mutateTasks(TEST_CHAT_ID, [t0.taskId], date, { completed: false });
    const fetched2 = await getTasksForDate(TEST_CHAT_ID, date);
    const ft0b = fetched2.find((t) => t.taskId === t0.taskId)!;
    assert.ok(!ft0b.completed, "t0 should be uncompleted");
    assert.ok(!ft0b.completedAt, "completedAt should be removed when uncompleted");
    console.log("  PASS");
}

async function testRolloverAcross3DayGap() {
    console.log("\n[5] rolloverTasks — 3-day gap");
    const day1 = "2000-02-01";
    const day4 = "2000-02-04"; // 3 days later

    const tasks = await addTasks(TEST_CHAT_ID, day1, ["task-A", "task-B", "task-C"]);

    // complete task-B — should NOT roll over
    await mutateTasks(TEST_CHAT_ID, [tasks[1].taskId], day1, { completed: true });

    const count = await rolloverTasks(TEST_CHAT_ID, day1, day4);
    assert.strictEqual(count, 2, "should roll over 2 incomplete tasks");

    const { getTasksForDate } = await import("../services/dynamodb.js");
    const rolled = await getTasksForDate(TEST_CHAT_ID, day4);
    assert.strictEqual(rolled.length, 2);
    for (const t of rolled) {
        assert.strictEqual(t.rolledOverFrom, day1);
        assert.ok(!t.completed, "rolled tasks start incomplete");
        assert.ok(t.taskId !== tasks[0].taskId, "rolled tasks get new ULIDs");
    }
    const texts = rolled.map((t) => t.text).sort();
    assert.deepStrictEqual(texts, ["task-A", "task-C"]);
    console.log("  PASS");
}

async function testMessageSaveAndFetchOrdering() {
    console.log("\n[6] saveMessage / getRecentMessages — chronological order, errors excluded");
    await saveMessage(TEST_CHAT_ID, { role: "user", kind: "chat", content: "msg-1" });
    await saveMessage(TEST_CHAT_ID, { role: "assistant", kind: "chat", content: "reply-1" });
    await saveMessage(TEST_CHAT_ID, { role: "assistant", kind: "error", content: "boom" });
    await saveMessage(TEST_CHAT_ID, { role: "user", kind: "chat", content: "msg-2" });

    const all = await getRecentMessages(TEST_CHAT_ID, 10);
    // Should be in chronological order (reversed from DynamoDB DESC query)
    assert.ok(all.length >= 4, "should have at least 4 messages");

    // Verify chronological order
    for (let i = 1; i < all.length; i++) {
        assert.ok(
            all[i].createdAt >= all[i - 1].createdAt,
            "messages should be in ascending time order"
        );
    }

    // Verify all kinds are stored (getRecentMessages returns them all; caller filters errors)
    const kinds = all.map((m) => m.kind);
    assert.ok(kinds.includes("error"), "errors are stored");
    assert.ok(kinds.includes("chat"), "chat messages are stored");

    console.log("  PASS");
}

async function testClaimCheckIn() {
    console.log("\n[7] claimCheckIn — true first call, false on duplicate");
    const localDate = "2000-03-01";

    const first = await claimCheckIn(TEST_CHAT_ID, "morning", localDate);
    assert.strictEqual(first, true, "first claim should succeed");

    const second = await claimCheckIn(TEST_CHAT_ID, "morning", localDate);
    assert.strictEqual(second, false, "duplicate claim same date should fail");

    // different type same date should succeed
    const afternoon = await claimCheckIn(TEST_CHAT_ID, "afternoon", localDate);
    assert.strictEqual(afternoon, true, "different type same date should succeed");

    // next day should succeed again
    const nextDay = await claimCheckIn(TEST_CHAT_ID, "morning", "2000-03-02");
    assert.strictEqual(nextDay, true, "next day claim should succeed");
    console.log("  PASS");
}

async function runAllTests() {
    console.log(`Starting Phase-1 DynamoDB tests (chatId: ${TEST_CHAT_ID})...`);
    resetRateLimit();

    try {
        await testCreateAndGetUser();
        await testGetUserNull();
        await testAddTasksAnd30Cap();
        await testMutateByTaskId();
        await testRolloverAcross3DayGap();
        await testMessageSaveAndFetchOrdering();
        await testClaimCheckIn();
        console.log("\nAll Phase-1 tests PASSED.\n");
    } catch (err) {
        console.error("\nTest FAILED:", (err as Error).message);
        console.error(err);
        process.exit(1);
    }
}

runAllTests();
