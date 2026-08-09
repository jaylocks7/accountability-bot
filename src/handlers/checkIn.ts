import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import {
    getAllUsers,
    getUser,
    claimCheckIn,
    incrementMissedCheckIns,
    updateUser,
    saveMessage,
    getTasksForDate,
} from "../services/dynamodb.js";
import { getLocalDate, getLocalHour } from "../services/dates.js";
import { sendMessage } from "../services/telegram.js";
import { formatTaskList } from "../services/format.js";

// ─── SQS client ───────────────────────────────────────────────────────────────

const REGION = process.env.AWS_REGION ?? "us-east-2";
const CHECKIN_QUEUE_URL = process.env.CHECKIN_QUEUE_URL ?? "";
const sqsClient = new SQSClient({ region: REGION });

interface SqsEntry {
    Id: string;
    MessageBody: string;
}

async function sqsSendBatch(entries: SqsEntry[]): Promise<void> {
    if (!CHECKIN_QUEUE_URL) throw new Error("CHECKIN_QUEUE_URL not set");
    await sqsClient.send(new SendMessageBatchCommand({
        QueueUrl: CHECKIN_QUEUE_URL,
        Entries: entries,
    }));
}

// ─── Dispatcher ────────────────────────────────────────────────────────────────

export async function dispatcher(): Promise<void> {
    const users = await getAllUsers();
    const due = users.filter((u) => u.status === "active" && u.checkInsEnabled);

    const entries: SqsEntry[] = [];
    for (const user of due) {
        const hour = getLocalHour(user.timezone);
        const localDate = getLocalDate(user.timezone);
        const { morning, afternoon, evening } = user.checkInHours;

        let checkInType: "morning" | "afternoon" | "evening" | null = null;
        if (hour === morning) checkInType = "morning";
        else if (hour === afternoon) checkInType = "afternoon";
        else if (hour === evening) checkInType = "evening";

        if (checkInType) {
            entries.push({
                Id: `${user.chatId}-${checkInType}`,
                MessageBody: JSON.stringify({ chatId: user.chatId, checkInType, localDate }),
            });
        }
    }

    if (entries.length === 0) return;

    // SendMessageBatch accepts max 10 per call
    for (let i = 0; i < entries.length; i += 10) {
        await sqsSendBatch(entries.slice(i, i + 10));
    }
    console.log(`[dispatcher] enqueued ${entries.length} check-in(s)`);
}

// ─── Worker ────────────────────────────────────────────────────────────────────

interface CheckInPayload {
    chatId: string;
    checkInType: "morning" | "afternoon" | "evening";
    localDate: string;
}

const SLEEP_THRESHOLD = 6;

async function runCheckInForUser(payload: CheckInPayload): Promise<void> {
    const { chatId, checkInType, localDate } = payload;

    // Step 1: verify user exists and has check-ins enabled
    const user = await getUser(chatId);
    if (!user || !user.checkInsEnabled) return;

    // Step 2: claim idempotency slot
    const claimed = await claimCheckIn(chatId, checkInType, localDate);
    if (!claimed) {
        console.log(`[worker] skipping duplicate ${checkInType} for ${chatId} on ${localDate}`);
        return;
    }

    // Step 3: increment missed check-ins
    const missed = await incrementMissedCheckIns(chatId);
    if (missed === SLEEP_THRESHOLD) {
        const sleepMsg =
            "I haven't heard from you in a while — I'll stop checking in for now. Message me anytime to wake me up!";
        await updateUser(chatId, { status: "sleeping" });
        await sendMessage(chatId, sleepMsg);
        await saveMessage(chatId, { role: "assistant", kind: "check_in", checkInType, content: sleepMsg });
        return;
    }
    if (missed > SLEEP_THRESHOLD) return;

    // Step 4: generate check-in message
    const tasks = await getTasksForDate(chatId, localDate);
    const taskList = formatTaskList(tasks);

    let text: string;
    if (checkInType === "morning") {
        text =
            `Good morning! Here's your list for today (${localDate}):\n\n${taskList}\n\nWhat are you tackling first?`;
    } else if (checkInType === "afternoon") {
        text =
            `Afternoon check-in! Here's where things stand:\n\n${taskList}\n\nHow's the day going? Any updates?`;
    } else {
        // evening — also sets eveningSession
        await updateUser(chatId, { eveningSession: true });
        const rolloverNote = user.autoRollover
            ? " Incomplete tasks will automatically carry over to tomorrow."
            : " Let me know if you'd like to roll anything over to tomorrow.";
        text =
            `Evening wrap-up! Here's your list:\n\n${taskList}\n\nHow'd you do today?${rolloverNote}`;
    }

    // Step 5: send and save
    await sendMessage(chatId, text);
    await saveMessage(chatId, { role: "assistant", kind: "check_in", checkInType, content: text });
}

// ─── SQS batch worker handler ─────────────────────────────────────────────────

interface SqsRecord {
    messageId: string;
    body: string;
}

export async function workerHandler(
    records: SqsRecord[]
): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
    const failures: { itemIdentifier: string }[] = [];

    for (const record of records) {
        try {
            const payload = JSON.parse(record.body) as CheckInPayload;
            await runCheckInForUser(payload);
        } catch (err) {
            console.error(`[worker] failed for messageId ${record.messageId}:`, err);
            failures.push({ itemIdentifier: record.messageId });
        }
    }

    return { batchItemFailures: failures };
}
