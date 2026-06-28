import { getTasksForDate, getPreferences, setEveningSession, incrementMissedCheckIns } from '../services/dynamodb.js';
import { sendMessage } from '../services/telegram.js';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

const client = new Anthropic();
const CHAT_ID = process.env.YOUR_TELEGRAM_CHAT_ID!;

function getDatePT(offsetDays = 0): string {
    const date = new Date();
    if (offsetDays) date.setDate(date.getDate() + offsetDays);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

function formatTasksForPrompt(taskRecord: any): string {
    const tasks = taskRecord?.tasks;
    if (!tasks?.length) return "No tasks on the list.";
    return tasks.map((task: any, i: number) => {
        const status = task.completed ? '[done]' : '[ ]';
        const priority = task.priority ? ' *' : '';
        return `${i}. ${status} ${task.text}${priority}`;
    }).join('\n');
}

const SLEEP_MESSAGE = "Hey, I'm gonna sleep since you haven't responded — message me to start our check-ins again!";

async function checkShouldProceed(): Promise<boolean> {
    const newCount = await incrementMissedCheckIns();
    if (newCount > 6) return false; // already sleeping, stay quiet
    if (newCount === 6) {
        await sendMessage(CHAT_ID, SLEEP_MESSAGE);
        return false;
    }
    return true;
}

async function callClaude(system: string, userContent: string): Promise<string> {
    const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        system,
        messages: [{ role: "user", content: userContent }]
    });
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('No text in Claude response');
    return textBlock.text;
}

async function morningCheckIn() {
    if (!await checkShouldProceed()) return;
    const today = getDatePT();
    let taskRecord = await getTasksForDate(today);
    if (!taskRecord) taskRecord = await getTasksForDate(getDatePT(-1));

    const taskList = formatTasksForPrompt(taskRecord);

    const text = await callClaude(
        `You are a friendly but firm accountability coach sending a morning check-in message.
        Reference the user's task list naturally — don't just recite it back.
        Be energizing and brief (3-4 sentences max).`,
        `Today's tasks:\n${taskList}`
    );

    await sendMessage(CHAT_ID, text);
}

async function afternoonCheckIn() {
    if (!await checkShouldProceed()) return;
    const today = getDatePT();
    let taskRecord = await getTasksForDate(today);
    if (!taskRecord) taskRecord = await getTasksForDate(getDatePT(-1));

    const taskList = formatTasksForPrompt(taskRecord);

    const text = await callClaude(
        `You are a friendly but firm accountability coach sending an afternoon check-in.
        Celebrate completed tasks, gently push on remaining ones.
        Be encouraging and brief (3-4 sentences max).`,
        `Task list:\n${taskList}`
    );

    await sendMessage(CHAT_ID, text);
}

async function eveningPrompt() {
    if (!await checkShouldProceed()) return;
    const today = getDatePT();

    const [taskRecord, prefs] = await Promise.all([
        getTasksForDate(today),
        getPreferences()
    ]);

    const incomplete = taskRecord?.tasks?.filter((t: any) => !t.completed) ?? [];

    await setEveningSession(true);

    let context: string;
    if (incomplete.length === 0) {
        context = "All tasks completed today — nothing to roll over.";
    } else {
        const taskLines = incomplete.map((t: any) => `- ${t.text}`).join('\n');
        context = prefs.autoRollover
            ? `Incomplete tasks that will carry over to tomorrow on your first message:\n${taskLines}`
            : `Incomplete tasks from today (auto-rollover is off, so they won't carry over):\n${taskLines}`;
    }

    const text = await callClaude(
        `You are a friendly but firm accountability coach sending an evening message.
        Briefly acknowledge today's results (celebrate if all done, acknowledge incomplete ones without shame).
        Mention whether incomplete tasks are carrying over to tomorrow or not.
        Ask the user to share any additional tasks they want on tomorrow's list.
        Keep it warm and brief (3-4 sentences max).`,
        context
    );

    await sendMessage(CHAT_ID, text);
}

export { morningCheckIn, afternoonCheckIn, eveningPrompt };
