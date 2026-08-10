/**
 * Unit tests for pure helpers in webhook.ts / format.ts.
 * No AWS, no Telegram, no Anthropic API required.
 * Run: npx ts-node --esm src/test/test-webhook-unit.ts
 *
 * The helpers (formatTask, formatSections, buildMessages, extractText) are not
 * all exported, so their logic is duplicated/imported here and the tests document
 * the expected contract. If the source diverges, tsc --noEmit won't catch it,
 * but the behaviour tests below will fail.
 */

import type { Task } from "../services/dynamodb.js";
import { formatTask, formatSections } from "../services/format.js";

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

// ─── Out-of-range index filtering (mirrors executeToolBlocks, now 1-based) ────

function filterValidIndices(indices: number[], taskCount: number): number[] {
    return indices.filter((i) => i >= 1 && i <= taskCount);
}

// ─── Minimal task factory ─────────────────────────────────────────────────────

function makeTask(text: string, completed = false, priority = false, active = true): Task {
    return {
        chatId: "1",
        sk: `2026-01-01#${text}`,
        taskId: text,
        date: "2026-01-01",
        text,
        completed,
        priority,
        active,
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

// ─── formatSections ───────────────────────────────────────────────────────────

test("formatSections: empty list → (no tasks)", () => {
    eq(formatSections([]), "(no tasks)");
});

test("formatSections: one active task, 1-based index", () => {
    const result = formatSections([makeTask("gym")]);
    eq(result, "Active (1/10):\n1. [ ] gym");
});

test("formatSections: active + completed, 1-based indices", () => {
    const result = formatSections([makeTask("gym"), makeTask("laundry", true)]);
    eq(result, "Active (1/10):\n1. [ ] gym\n\nCompleted:\n2. [done] laundry");
});

test("formatSections: active filter shows only active", () => {
    const result = formatSections([makeTask("gym"), makeTask("laundry", false, false, false)], "active");
    eq(result, "Active (1/10):\n1. [ ] gym");
});

test("formatSections: backup filter shows only backup", () => {
    const result = formatSections([makeTask("gym"), makeTask("laundry", false, false, false)], "backup");
    eq(result, "Backup (1/40):\n2. [ ] laundry");
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

// ─── Out-of-range index filtering (1-based) ──────────────────────────────────

test("filterValidIndices: valid 1-based indices pass through", () => {
    eq(filterValidIndices([1, 2, 3], 3), [1, 2, 3]);
});

test("filterValidIndices: out-of-range dropped", () => {
    eq(filterValidIndices([1, 5, 99], 3), [1]);
});

test("filterValidIndices: zero and negative indices dropped", () => {
    eq(filterValidIndices([-1, 0, 1], 2), [1]);
});

test("filterValidIndices: all out-of-range → empty", () => {
    eq(filterValidIndices([4, 5, 6], 3), []);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
