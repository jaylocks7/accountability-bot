import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    PutCommand,
    QueryCommand,
    UpdateCommand,
    GetCommand,
    DeleteCommand,
    BatchWriteCommand,
    ScanCommand,
    DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ulid } from "ulid";

const client = new DynamoDBClient({ region: "us-east-2" });
const docClient = DynamoDBDocumentClient.from(client);

const USERS_TABLE = process.env.USERS_TABLE ?? "Users";
const TASKS_TABLE = process.env.TASKS_TABLE ?? "Tasks";
const MESSAGES_TABLE = process.env.MESSAGES_TABLE ?? "Messages";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface User {
    chatId: string;
    firstName: string;
    timezone: string;
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

export interface Task {
    chatId: string;
    sk: string;
    taskId: string;
    date: string;
    text: string;
    completed: boolean;
    priority: boolean;
    active: boolean;
    createdAt: number;
    completedAt?: number;
    rolledOverFrom?: string;
}

export interface StoredMessage {
    chatId: string;
    sk: string;
    role: "user" | "assistant";
    kind: "chat" | "check_in" | "error";
    checkInType?: "morning" | "afternoon" | "evening";
    content: string;
    createdAt: number;
    expiresAt: number;
}

// ─── Rate limiting (in-memory, keyed by chatId) ───────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 60000;

export function checkRateLimit(chatId: string): void {
    const now = Date.now();
    const limitData = rateLimitMap.get(chatId);
    if (!limitData || now > limitData.resetTime) {
        rateLimitMap.set(chatId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return;
    }
    if (limitData.count >= RATE_LIMIT_MAX) {
        throw new Error(`Rate limit exceeded for ${chatId}. Max ${RATE_LIMIT_MAX} operations per minute.`);
    }
    limitData.count++;
}

export function resetRateLimit(chatId?: string): void {
    if (chatId) {
        rateLimitMap.delete(chatId);
    } else {
        rateLimitMap.clear();
    }
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

export function sanitizeText(text: string): string {
    return text.replace(/[^a-zA-Z0-9'\s!@$+]/g, "").trim();
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function getUser(chatId: string): Promise<User | null> {
    const response = await docClient.send(
        new GetCommand({ TableName: USERS_TABLE, Key: { chatId } })
    );
    return (response.Item as User) ?? null;
}

export async function createUser(chatId: string, firstName: string): Promise<User> {
    const now = Date.now();
    const user: User = {
        chatId,
        firstName,
        timezone: "America/Los_Angeles",
        checkInHours: { morning: 9, afternoon: 18, evening: 23 },
        checkInsEnabled: false,
        autoRollover: false,
        missedCheckIns: 0,
        eveningSession: false,
        status: "active",
        lastCheckIns: {},
        createdAt: now,
        lastResponseAt: now,
    };
    await docClient.send(new PutCommand({ TableName: USERS_TABLE, Item: user }));
    return user;
}

export async function updateUser(
    chatId: string,
    patch: Partial<Omit<User, "chatId">>
): Promise<void> {
    if (Object.keys(patch).length === 0) return;

    const sets: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(patch)) {
        sets.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
    }

    await docClient.send(
        new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { chatId },
            UpdateExpression: `SET ${sets.join(", ")}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
        })
    );
}

export async function getAllUsers(): Promise<User[]> {
    // ponytail: Scan is fine — table stays small (one row per human user)
    const response = await docClient.send(new ScanCommand({ TableName: USERS_TABLE }));
    return (response.Items ?? []) as User[];
}

export async function incrementMissedCheckIns(chatId: string): Promise<number> {
    const response = await docClient.send(
        new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { chatId },
            UpdateExpression: "SET missedCheckIns = if_not_exists(missedCheckIns, :zero) + :one",
            ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
            ReturnValues: "UPDATED_NEW",
        })
    );
    return response.Attributes?.missedCheckIns as number;
}

export async function resetMissedCheckIns(chatId: string): Promise<void> {
    await docClient.send(
        new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { chatId },
            UpdateExpression: "SET missedCheckIns = :zero, #status = :active, lastResponseAt = :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
                ":zero": 0,
                ":active": "active",
                ":now": Date.now(),
            },
        })
    );
}

export async function claimCheckIn(
    chatId: string,
    type: "morning" | "afternoon" | "evening",
    localDate: string
): Promise<boolean> {
    try {
        await docClient.send(
            new UpdateCommand({
                TableName: USERS_TABLE,
                Key: { chatId },
                UpdateExpression: "SET lastCheckIns.#t = :date",
                ConditionExpression:
                    "attribute_not_exists(lastCheckIns.#t) OR lastCheckIns.#t <> :date",
                ExpressionAttributeNames: { "#t": type },
                ExpressionAttributeValues: { ":date": localDate },
            })
        );
        return true;
    } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
    }
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export async function getTasksForDate(chatId: string, date: string): Promise<Task[]> {
    const response = await docClient.send(
        new QueryCommand({
            TableName: TASKS_TABLE,
            KeyConditionExpression: "chatId = :c AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: { ":c": chatId, ":prefix": `${date}#` },
        })
    );
    return (response.Items ?? []) as Task[];
}

export async function addTasks(
    chatId: string,
    date: string,
    texts: string[],
    preferActive: boolean = true
): Promise<Task[]> {
    const existing = await getTasksForDate(chatId, date);

    // Dedup: skip texts that match an existing task (case-insensitive)
    const existingLower = existing.map((t) => t.text.toLowerCase());
    const deduped = texts.filter((raw) => {
        const sanitized = sanitizeText(raw).slice(0, 500);
        return !existingLower.includes(sanitized.toLowerCase());
    });

    if (deduped.length === 0) return [];

    const activeCount = existing.filter((t) => t.active && !t.completed).length;
    const backupCount = existing.filter((t) => !t.active && !t.completed).length;
    const activeSlots = Math.max(0, 10 - activeCount);
    const backupSlots = Math.max(0, 40 - backupCount);

    const now = Date.now();
    const newTasks: Task[] = [];

    if (preferActive) {
        let aUsed = 0, bUsed = 0;
        for (const raw of deduped) {
            const text = sanitizeText(raw).slice(0, 500);
            if (!text) continue;
            let active: boolean;
            if (aUsed < activeSlots) { active = true; aUsed++; }
            else if (bUsed < backupSlots) { active = false; bUsed++; }
            else break; // both caps full
            const taskId = ulid();
            newTasks.push({ chatId, sk: `${date}#${taskId}`, taskId, date, text, completed: false, priority: false, active, createdAt: now });
        }
    } else {
        let bUsed = 0;
        for (const raw of deduped) {
            if (bUsed >= backupSlots) break;
            const text = sanitizeText(raw).slice(0, 500);
            if (!text) continue;
            const taskId = ulid();
            newTasks.push({ chatId, sk: `${date}#${taskId}`, taskId, date, text, completed: false, priority: false, active: false, createdAt: now });
            bUsed++;
        }
    }

    if (newTasks.length === 0) return [];

    // BatchWrite in chunks of 25
    for (let i = 0; i < newTasks.length; i += 25) {
        const chunk = newTasks.slice(i, i + 25);
        await docClient.send(
            new BatchWriteCommand({
                RequestItems: {
                    [TASKS_TABLE]: chunk.map((t) => ({ PutRequest: { Item: t } })),
                },
            })
        );
    }

    return newTasks;
}

export async function mutateTasks(
    chatId: string,
    taskIds: string[],
    date: string,
    patch: { completed?: boolean; priority?: boolean; active?: boolean }
): Promise<void> {
    if (taskIds.length === 0 || Object.keys(patch).length === 0) return;

    const sets: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    if (patch.completed !== undefined) {
        sets.push("#completed = :completed");
        names["#completed"] = "completed";
        values[":completed"] = patch.completed;
        if (patch.completed) {
            sets.push("completedAt = :ts");
            values[":ts"] = Date.now();
        } else {
            // remove completedAt when uncompleting — use REMOVE expression
        }
    }
    if (patch.priority !== undefined) {
        sets.push("#priority = :priority");
        names["#priority"] = "priority";
        values[":priority"] = patch.priority;
    }
    if (patch.active !== undefined) {
        sets.push("#active = :active");
        names["#active"] = "active";
        values[":active"] = patch.active;
    }

    const removeCompletedAt = patch.completed === false;

    for (const taskId of taskIds) {
        const sk = `${date}#${taskId}`;
        let updateExpr = `SET ${sets.join(", ")}`;
        if (removeCompletedAt) updateExpr += " REMOVE completedAt";
        await docClient.send(
            new UpdateCommand({
                TableName: TASKS_TABLE,
                Key: { chatId, sk },
                UpdateExpression: updateExpr,
                ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
                ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
            })
        );
    }
}

export async function removeTasks(
    chatId: string,
    taskIds: string[],
    date: string
): Promise<void> {
    if (taskIds.length === 0) return;

    for (const taskId of taskIds) {
        await docClient.send(
            new DeleteCommand({
                TableName: TASKS_TABLE,
                Key: { chatId, sk: `${date}#${taskId}` },
            })
        );
    }
}

export async function rolloverTasks(
    chatId: string,
    fromDate: string,
    toDate: string
): Promise<number> {
    const source = await getTasksForDate(chatId, fromDate);
    const incomplete = source.filter((t) => !t.completed);
    if (incomplete.length === 0) return 0;

    const dest = await getTasksForDate(chatId, toDate);
    const destActive = dest.filter((t) => t.active && !t.completed).length;
    const destBackup = dest.filter((t) => !t.active && !t.completed).length;
    const activeSlots = Math.max(0, 10 - destActive);
    const backupSlots = Math.max(0, 40 - destBackup);

    let aUsed = 0, bUsed = 0;
    const toRoll = incomplete.filter((t) => {
        if (t.active) { if (aUsed < activeSlots) { aUsed++; return true; } return false; }
        else { if (bUsed < backupSlots) { bUsed++; return true; } return false; }
    });
    if (toRoll.length === 0) return 0;

    const now = Date.now();
    const newTasks: Task[] = toRoll.map((t) => {
        const taskId = ulid();
        return {
            chatId,
            sk: `${toDate}#${taskId}`,
            taskId,
            date: toDate,
            text: t.text,
            completed: false,
            priority: t.priority,
            active: t.active,
            createdAt: now,
            rolledOverFrom: fromDate,
        };
    });

    for (let i = 0; i < newTasks.length; i += 25) {
        const chunk = newTasks.slice(i, i + 25);
        await docClient.send(
            new BatchWriteCommand({
                RequestItems: {
                    [TASKS_TABLE]: chunk.map((t) => ({ PutRequest: { Item: t } })),
                },
            })
        );
    }

    return newTasks.length;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function saveMessage(
    chatId: string,
    msg: {
        role: "user" | "assistant";
        kind: "chat" | "check_in" | "error";
        content: string;
        checkInType?: string;
    }
): Promise<void> {
    const now = Date.now();
    const sk = `${String(now).padStart(13, "0")}#${ulid()}`;
    const item: StoredMessage = {
        chatId,
        sk,
        role: msg.role,
        kind: msg.kind,
        content: msg.content,
        createdAt: now,
        expiresAt: Math.floor(now / 1000) + 30 * 24 * 3600,
        ...(msg.checkInType
            ? { checkInType: msg.checkInType as "morning" | "afternoon" | "evening" }
            : {}),
    };
    await docClient.send(new PutCommand({ TableName: MESSAGES_TABLE, Item: item }));
}

export async function getRecentMessages(chatId: string, limit = 12): Promise<StoredMessage[]> {
    const response = await docClient.send(
        new QueryCommand({
            TableName: MESSAGES_TABLE,
            KeyConditionExpression: "chatId = :c",
            ExpressionAttributeValues: { ":c": chatId },
            ScanIndexForward: false,
            Limit: limit,
        })
    );
    const items = ((response.Items ?? []) as StoredMessage[]).reverse();
    return items;
}
