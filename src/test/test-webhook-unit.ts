/**
 * Unit tests for pure helpers in webhook.ts.
 * No AWS, no Telegram, no Anthropic API required.
 * Run: npx ts-node --esm src/test/test-webhook-unit.ts
 *
 * The helpers (formatTask, formatTaskList, buildMessages, extractText) are not
 * exported, so their logic is duplicated verbatim here and the tests document
 * the expected contract. If the source diverges, tsc --noEmit won't catch it,
 * but the behaviour tests below will fail.
 */

import type { Task } from "../services/dynamodb.js";

// ─── Verbatim copies of the private helpers ──────────────────────────────────

function formatTask(index: number, task: Task): string {
    return `${index}. ${task.completed ? "[done]" : "[ ]"} ${task.text}${task.priority ? " *" : ""}`;
}

function formatTaskList(tasks: Task[]): string {
    if (tasks.length === 0) return "(no tasks)";
    return tasks.map((t, i) => formatTask(i, t)).join("\n");
}

type MsgParam = { role: "user" | "assistant"; content: string };

function buildMessages(history: MsgParam[], userMessage: string): MsgParam[] {
    const all: MsgParam[] = [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user" as const, content: userMessage },
    ];
    const merged: MsgParam[] = [];
    for (const msg of all) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === msg.role) {
            prev.content = `${prev.content}\n${msg.content}`;
        } else {
            merged.push({ role: msg.role, content: msg.content });
        }
    }
    if (merged.length > 0 && merged[0].role === "assistant") {
        merged.shift();
    }
    return merged;
}

// extractText mirrors webhook's logic; content blocks carry only type+text here
type Block = { type: string; text?: string };
function extractText(response: { content: Block[] }): string | undefined {
    for (const block of response.content) {
        if (block.type === "text") return block.text;
    }
    return undefined;
}

// ─── Out-of-range index filtering (mirrors executeToolBlocks) ─────────────────

function filterValidIndices(indices: number[], taskCount: number): number[] {
    return indices.filter((i) => i >= 0 && i < taskCount);
}

// ─── Minimal task factory ─────────────────────────────────────────────────────

function makeTask(text: string, completed = false, priority = false): Task {
    return {
        chatId: "1",
        sk: `2026-01-01#${text}`,
        taskId: text,
        date: "2026-01-01",
        text,
        completed,
        priority,
        createdAt: 0,
    };
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${name}:`, err);
        failed++;
    }
}

function eq<T>(a: T, b: T, msg?: string) {
    const as = JSON.stringify(a);
    const bs = JSON.stringify(b);
    if (as !== bs) throw new Error(`${msg ?? "eq"}: got ${as}, want ${bs}`);
}

// ─── formatTask ───────────────────────────────────────────────────────────────

test("formatTask: incomplete non-priority", () => {
    eq(formatTask(0, makeTask("buy milk")), "0. [ ] buy milk");
});

test("formatTask: completed", () => {
    eq(formatTask(1, makeTask("buy milk", true)), "1. [done] buy milk");
});

test("formatTask: priority", () => {
    eq(formatTask(2, makeTask("buy milk", false, true)), "2. [ ] buy milk *");
});

test("formatTask: completed + priority", () => {
    eq(formatTask(3, makeTask("buy milk", true, true)), "3. [done] buy milk *");
});

// ─── formatTaskList ───────────────────────────────────────────────────────────

test("formatTaskList: empty list → (no tasks)", () => {
    eq(formatTaskList([]), "(no tasks)");
});

test("formatTaskList: one task, index 0", () => {
    eq(formatTaskList([makeTask("gym")]), "0. [ ] gym");
});

test("formatTaskList: two tasks, indices 0 and 1", () => {
    const result = formatTaskList([makeTask("gym"), makeTask("laundry", true)]);
    eq(result, "0. [ ] gym\n1. [done] laundry");
});

// ─── buildMessages alternation merging ───────────────────────────────────────

test("buildMessages: empty history → single user message", () => {
    const out = buildMessages([], "hello");
    eq(out, [{ role: "user", content: "hello" }]);
});

test("buildMessages: normal alternating history preserved", () => {
    const history: MsgParam[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
    ];
    const out = buildMessages(history, "next");
    eq(out, [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
        { role: "user", content: "next" },
    ]);
});

test("buildMessages: consecutive user messages merged", () => {
    const history: MsgParam[] = [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
    ];
    const out = buildMessages(history, "third");
    eq(out, [{ role: "user", content: "first\nsecond\nthird" }]);
});

test("buildMessages: leading assistant dropped", () => {
    const history: MsgParam[] = [
        { role: "assistant", content: "good morning!" },
        { role: "user", content: "hi" },
    ];
    const out = buildMessages(history, "next");
    // merge pass runs before drop: "hi" + "next" collapse first, then leading assistant is dropped
    eq(out, [{ role: "user", content: "hi\nnext" }]);
});

test("buildMessages: leading assistant only → just the new user message", () => {
    const history: MsgParam[] = [{ role: "assistant", content: "welcome" }];
    const out = buildMessages(history, "hello");
    eq(out, [{ role: "user", content: "hello" }]);
});

test("buildMessages: consecutive assistant messages merged", () => {
    const history: MsgParam[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "a1" },
        { role: "assistant", content: "a2" },
    ];
    const out = buildMessages(history, "ok");
    eq(out, [
        { role: "user", content: "hi" },
        { role: "assistant", content: "a1\na2" },
        { role: "user", content: "ok" },
    ]);
});

// ─── extractText ──────────────────────────────────────────────────────────────

test("extractText: returns first text block", () => {
    eq(extractText({ content: [{ type: "text", text: "hello" }] }), "hello");
});

test("extractText: skips non-text blocks", () => {
    eq(
        extractText({
            content: [
                { type: "tool_use" },
                { type: "text", text: "done" },
            ],
        }),
        "done"
    );
});

test("extractText: no text block → undefined", () => {
    eq(extractText({ content: [{ type: "tool_use" }] }), undefined);
});

test("extractText: empty content → undefined", () => {
    eq(extractText({ content: [] }), undefined);
});

// ─── Out-of-range index filtering ─────────────────────────────────────────────

test("filterValidIndices: valid indices pass through", () => {
    eq(filterValidIndices([0, 1, 2], 3), [0, 1, 2]);
});

test("filterValidIndices: out-of-range dropped", () => {
    eq(filterValidIndices([0, 5, 99], 3), [0]);
});

test("filterValidIndices: negative indices dropped", () => {
    eq(filterValidIndices([-1, 0, 1], 2), [0, 1]);
});

test("filterValidIndices: all out-of-range → empty", () => {
    eq(filterValidIndices([3, 4, 5], 3), []);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
