import type { Task } from "./dynamodb.js";

export function formatTask(index: number, task: Task): string {
    return `${index}. ${task.completed ? "[done]" : "[ ]"} ${task.text}${task.priority ? " *" : ""}`;
}

export function formatTaskList(tasks: Task[]): string {
    if (tasks.length === 0) return "(no tasks)";
    return tasks.map((t, i) => formatTask(i, t)).join("\n");
}
