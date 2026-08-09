import { getTasksForDate } from "./dynamodb.js";

export function getLocalDate(timezone: string, offsetDays = 0): string {
    const date = new Date();
    if (offsetDays) date.setDate(date.getDate() + offsetDays);
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

export function getLocalHour(timezone: string): number {
    return parseInt(
        new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            hour12: false,
        }).format(new Date()),
        10
    );
}

export async function mostRecentTaskDate(chatId: string, before: string): Promise<string | null> {
    const [year, month, day] = before.split("-").map(Number);
    for (let i = 1; i <= 7; i++) {
        const d = new Date(year, month - 1, day - i);
        const candidate = new Intl.DateTimeFormat("en-CA").format(d);
        const tasks = await getTasksForDate(chatId, candidate);
        if (tasks.length > 0) return candidate;
    }
    return null;
}
