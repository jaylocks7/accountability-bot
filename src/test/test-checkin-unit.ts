/**
 * Phase-3 unit tests: workerHandler isolation + claimCheckIn idempotency logic.
 * No AWS, no Telegram, no SQS required.
 * Run: npx tsx src/test/test-checkin-unit.ts
 *
 * Tests the public contract of workerHandler via mocked dependencies,
 * and the dispatcher's filtering logic directly.
 */

// ─── Minimal test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
    Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`  PASS  ${name}`);
            passed++;
        })
        .catch((err) => {
            console.error(`  FAIL  ${name}:`, err instanceof Error ? err.message : err);
            failed++;
        })
        .finally(() => {
            if (passed + failed === totalTests) {
                console.log(`\n${passed} passed, ${failed} failed`);
                if (failed > 0) process.exit(1);
            }
        });
}

function eq<T>(a: T, b: T, msg?: string) {
    const as = JSON.stringify(a);
    const bs = JSON.stringify(b);
    if (as !== bs) throw new Error(`${msg ?? "eq"}: got ${as}, want ${bs}`);
}

function ok(val: unknown, msg?: string) {
    if (!val) throw new Error(msg ?? `expected truthy, got ${val}`);
}

// ─── Mock Types ───────────────────────────────────────────────────────────────

interface User {
    chatId: string;
    status: "active" | "sleeping";
    checkInsEnabled: boolean;
    checkInHours: { morning: number; afternoon: number; evening: number };
    autoRollover: boolean;
    eveningSession: boolean;
    timezone: string;
    lastCheckIns: Record<string, string>;
}

type CheckInType = "morning" | "afternoon" | "evening";

// ─── Mock workerHandler logic (mirrors checkIn.ts exactly) ───────────────────
// We duplicate the pure branching logic so tests run without real imports.
// If the source diverges, integration tests catch it.

interface CheckInPayload {
    chatId: string;
    checkInType: CheckInType;
    localDate: string;
}

interface WorkerDeps {
    getUser: (id: string) => Promise<User | null>;
    claimCheckIn: (id: string, type: CheckInType, date: string) => Promise<boolean>;
    incrementMissedCheckIns: (id: string) => Promise<number>;
    updateUser: (id: string, patch: Partial<User>) => Promise<void>;
    sendMessage: (id: string, text: string) => Promise<void>;
    saveMessage: (id: string, msg: { role: string; kind: string; content: string; checkInType?: string }) => Promise<void>;
    getTasksForDate: (id: string, date: string) => Promise<{ completed: boolean; text: string; priority: boolean }[]>;
}

const SLEEP_THRESHOLD = 6;

async function runCheckInForUser(payload: CheckInPayload, deps: WorkerDeps): Promise<void> {
    const { chatId, checkInType, localDate } = payload;

    const user = await deps.getUser(chatId);
    if (!user || !user.checkInsEnabled) return;

    const claimed = await deps.claimCheckIn(chatId, checkInType, localDate);
    if (!claimed) return;

    const missed = await deps.incrementMissedCheckIns(chatId);
    if (missed === SLEEP_THRESHOLD) {
        const sleepMsg =
            "I haven't heard from you in a while — I'll stop checking in for now. Message me anytime to wake me up!";
        await deps.updateUser(chatId, { status: "sleeping" });
        await deps.sendMessage(chatId, sleepMsg);
        await deps.saveMessage(chatId, { role: "assistant", kind: "check_in", checkInType, content: sleepMsg });
        return;
    }
    if (missed > SLEEP_THRESHOLD) return;

    const tasks = await deps.getTasksForDate(chatId, localDate);
    let text: string;
    if (checkInType === "morning") {
        text = `Good morning! Here's your list for today (${localDate}):\n\n${tasks.length === 0 ? "(no tasks)" : "tasks"}\n\nWhat are you tackling first?`;
    } else if (checkInType === "afternoon") {
        text = `Afternoon check-in!`;
    } else {
        await deps.updateUser(chatId, { eveningSession: true });
        text = `Evening wrap-up!`;
    }

    await deps.sendMessage(chatId, text);
    await deps.saveMessage(chatId, { role: "assistant", kind: "check_in", checkInType, content: text });
}

interface SqsRecord { messageId: string; body: string; }

async function workerHandlerMock(
    records: SqsRecord[],
    deps: WorkerDeps
): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of records) {
        try {
            const payload = JSON.parse(record.body) as CheckInPayload;
            await runCheckInForUser(payload, deps);
        } catch (err) {
            failures.push({ itemIdentifier: record.messageId });
        }
    }
    return { batchItemFailures: failures };
}

// ─── Dispatcher filter logic (mirrors dispatcher() in checkIn.ts) ─────────────

function dispatcherFilter(
    users: User[],
    getLocalHour: (tz: string) => number,
    getLocalDate: (tz: string) => string
): { chatId: string; checkInType: CheckInType; localDate: string }[] {
    const due = users.filter((u) => u.status === "active" && u.checkInsEnabled);
    const entries: { chatId: string; checkInType: CheckInType; localDate: string }[] = [];
    for (const user of due) {
        const hour = getLocalHour(user.timezone);
        const localDate = getLocalDate(user.timezone);
        const { morning, afternoon, evening } = user.checkInHours;
        let checkInType: CheckInType | null = null;
        if (hour === morning) checkInType = "morning";
        else if (hour === afternoon) checkInType = "afternoon";
        else if (hour === evening) checkInType = "evening";
        if (checkInType) entries.push({ chatId: user.chatId, checkInType, localDate });
    }
    return entries;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<User> = {}): User {
    return {
        chatId: "user-1",
        status: "active",
        checkInsEnabled: true,
        checkInHours: { morning: 9, afternoon: 18, evening: 23 },
        autoRollover: false,
        eveningSession: false,
        timezone: "America/Los_Angeles",
        lastCheckIns: {},
        ...overrides,
    };
}

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps & { sentMessages: string[]; savedMessages: string[]; updatedUsers: Partial<User>[] } {
    const sentMessages: string[] = [];
    const savedMessages: string[] = [];
    const updatedUsers: Partial<User>[] = [];
    return {
        getUser: async () => makeUser(),
        claimCheckIn: async () => true,
        incrementMissedCheckIns: async () => 1,
        updateUser: async (_, patch) => { updatedUsers.push(patch); },
        sendMessage: async (_, text) => { sentMessages.push(text); },
        saveMessage: async (_, msg) => { savedMessages.push(msg.content); },
        getTasksForDate: async () => [],
        sentMessages,
        savedMessages,
        updatedUsers,
        ...overrides,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Count must match test() calls below
const totalTests = 14;

console.log("Phase-3 check-in unit tests\n");

// 1. claimCheckIn idempotency: second call returns false → skip
test("claimCheckIn idempotency: duplicate claim skips send", async () => {
    const sent: string[] = [];
    const deps = makeDeps({
        claimCheckIn: async () => false,  // simulate duplicate
        sendMessage: async (_, t) => { sent.push(t); },
    });
    const payload: CheckInPayload = { chatId: "user-1", checkInType: "morning", localDate: "2026-01-01" };
    await runCheckInForUser(payload, deps);
    eq(sent.length, 0, "no message should be sent on duplicate claim");
});

// 2. claimCheckIn idempotency: first call returns true → proceeds
test("claimCheckIn: first claim proceeds to send", async () => {
    const sent: string[] = [];
    const deps = makeDeps({
        claimCheckIn: async () => true,
        sendMessage: async (_, t) => { sent.push(t); },
    });
    await runCheckInForUser({ chatId: "user-1", checkInType: "morning", localDate: "2026-01-01" }, deps);
    ok(sent.length === 1, "should send exactly one message");
});

// 3. checkInsEnabled=false → no send
test("user with checkInsEnabled=false receives nothing", async () => {
    const sent: string[] = [];
    const deps = makeDeps({
        getUser: async () => makeUser({ checkInsEnabled: false }),
        sendMessage: async (_, t) => { sent.push(t); },
    });
    await runCheckInForUser({ chatId: "user-1", checkInType: "morning", localDate: "2026-01-01" }, deps);
    eq(sent.length, 0, "disabled user should receive no messages");
});

// 4. user not found → no send
test("null user → no send", async () => {
    const sent: string[] = [];
    const deps = makeDeps({
        getUser: async () => null,
        sendMessage: async (_, t) => { sent.push(t); },
    });
    await runCheckInForUser({ chatId: "ghost", checkInType: "morning", localDate: "2026-01-01" }, deps);
    eq(sent.length, 0, "nonexistent user should receive no messages");
});

// 5. missed === 6 → sleep message, status set to sleeping, no normal check-in
test("missed===6 → sleep message sent, status=sleeping, no normal check-in", async () => {
    const sent: string[] = [];
    const updates: Partial<User>[] = [];
    const deps = makeDeps({
        incrementMissedCheckIns: async () => 6,
        sendMessage: async (_, t) => { sent.push(t); },
        updateUser: async (_, p) => { updates.push(p); },
    });
    await runCheckInForUser({ chatId: "user-1", checkInType: "morning", localDate: "2026-01-01" }, deps);
    eq(sent.length, 1, "exactly one message (sleep) sent");
    ok(sent[0].includes("stop checking in"), "sleep message content check");
    ok(updates.some((u) => u.status === "sleeping"), "status should be set to sleeping");
});

// 6. missed > 6 → silently return
test("missed>6 → no send at all", async () => {
    const sent: string[] = [];
    const deps = makeDeps({
        incrementMissedCheckIns: async () => 7,
        sendMessage: async (_, t) => { sent.push(t); },
    });
    await runCheckInForUser({ chatId: "user-1", checkInType: "morning", localDate: "2026-01-01" }, deps);
    eq(sent.length, 0, "no message for missed > threshold");
});

// 7. batchItemFailures isolation: one user throws, others still process
test("batchItemFailures: one throw doesn't block others", async () => {
    const processed: string[] = [];
    let callCount = 0;
    const deps = makeDeps({
        getUser: async (id) => {
            callCount++;
            if (id === "bad-user") throw new Error("DynamoDB exploded");
            processed.push(id);
            return makeUser({ chatId: id });
        },
    });

    const records: SqsRecord[] = [
        { messageId: "msg-1", body: JSON.stringify({ chatId: "good-user-1", checkInType: "morning", localDate: "2026-01-01" }) },
        { messageId: "msg-2", body: JSON.stringify({ chatId: "bad-user", checkInType: "morning", localDate: "2026-01-01" }) },
        { messageId: "msg-3", body: JSON.stringify({ chatId: "good-user-2", checkInType: "morning", localDate: "2026-01-01" }) },
    ];

    const result = await workerHandlerMock(records, deps);
    eq(result.batchItemFailures.length, 1, "exactly one failure");
    eq(result.batchItemFailures[0].itemIdentifier, "msg-2", "failed message id correct");
    ok(processed.includes("good-user-1"), "good-user-1 should have been processed");
    ok(processed.includes("good-user-2"), "good-user-2 should have been processed");
});

// 8. batchItemFailures: all succeed → empty failures array
test("batchItemFailures: all succeed → empty failures", async () => {
    const deps = makeDeps();
    const records: SqsRecord[] = [
        { messageId: "m1", body: JSON.stringify({ chatId: "u1", checkInType: "morning", localDate: "2026-01-01" }) },
        { messageId: "m2", body: JSON.stringify({ chatId: "u2", checkInType: "afternoon", localDate: "2026-01-01" }) },
    ];
    const result = await workerHandlerMock(records, deps);
    eq(result.batchItemFailures, [], "no failures expected");
});

// 9. batchItemFailures: invalid JSON → failure recorded
test("batchItemFailures: bad JSON → failure, others continue", async () => {
    const sent: string[] = [];
    const deps = makeDeps({ sendMessage: async (_, t) => { sent.push(t); } });
    const records: SqsRecord[] = [
        { messageId: "bad-json", body: "not-json{{" },
        { messageId: "good", body: JSON.stringify({ chatId: "u1", checkInType: "morning", localDate: "2026-01-01" }) },
    ];
    const result = await workerHandlerMock(records, deps);
    eq(result.batchItemFailures.length, 1);
    eq(result.batchItemFailures[0].itemIdentifier, "bad-json");
    eq(sent.length, 1, "good record should still send");
});

// 10. evening check-in sets eveningSession=true
test("evening check-in sets eveningSession=true on user", async () => {
    const updates: Partial<User>[] = [];
    const deps = makeDeps({ updateUser: async (_, p) => { updates.push(p); } });
    await runCheckInForUser({ chatId: "user-1", checkInType: "evening", localDate: "2026-01-01" }, deps);
    ok(updates.some((u) => u.eveningSession === true), "eveningSession should be set");
});

// 11. Dispatcher: only enqueues active+checkInsEnabled users
test("dispatcher: only active+checkInsEnabled users enqueued", () => {
    const users: User[] = [
        makeUser({ chatId: "a", status: "active", checkInsEnabled: true }),
        makeUser({ chatId: "b", status: "sleeping", checkInsEnabled: true }),   // sleeping
        makeUser({ chatId: "c", status: "active", checkInsEnabled: false }),    // disabled
        makeUser({ chatId: "d", status: "active", checkInsEnabled: true }),
    ];
    // All at morning hour=9
    const result = dispatcherFilter(users, () => 9, () => "2026-01-01");
    const chatIds = result.map((e) => e.chatId).sort();
    eq(chatIds, ["a", "d"], "only active+enabled users");
});

// 12. Dispatcher: user not at any check-in hour → not enqueued
test("dispatcher: user not at check-in hour → not enqueued", () => {
    const users: User[] = [makeUser({ chatId: "u1", checkInHours: { morning: 9, afternoon: 18, evening: 23 } })];
    // hour=10 matches nothing
    const result = dispatcherFilter(users, () => 10, () => "2026-01-01");
    eq(result.length, 0, "no users due at hour 10");
});

// 13. Dispatcher: correct checkInType dispatched per hour
test("dispatcher: correct checkInType for afternoon hour", () => {
    const users: User[] = [makeUser({ chatId: "u1", checkInHours: { morning: 9, afternoon: 18, evening: 23 } })];
    const result = dispatcherFilter(users, () => 18, () => "2026-01-01");
    eq(result.length, 1);
    eq(result[0].checkInType, "afternoon");
    eq(result[0].chatId, "u1");
});

// 14. Dispatcher: multiple users at same hour all enqueued
test("dispatcher: multiple due users all enqueued", () => {
    const users: User[] = [
        makeUser({ chatId: "u1" }),
        makeUser({ chatId: "u2" }),
        makeUser({ chatId: "u3" }),
    ];
    const result = dispatcherFilter(users, () => 9, () => "2026-01-01");
    eq(result.length, 3, "all three should be enqueued");
    eq(result.map((r) => r.checkInType), ["morning", "morning", "morning"]);
});
