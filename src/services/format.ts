import type { Task } from "./dynamodb.js";

// 1-based index passed by caller
export function formatTask(index: number, task: Task): string {
    return `${index}. ${task.completed ? "[done]" : "[ ]"} ${task.text}${task.priority ? " *" : ""}`;
}

export function formatSections(tasks: Task[], filter?: "active" | "backup" | "completed" | "priority"): string {
    if (tasks.length === 0) return "(no tasks)";

    // Assign global 1-based indices in creation order (tasks already sorted by sk/ULID)
    const indexed = tasks.map((task, i) => ({ task, idx: i + 1 }));

    const fmt = ({ task, idx }: { task: Task; idx: number }) => formatTask(idx, task);

    const active    = indexed.filter(({ task }) => task.active && !task.completed);
    const backup    = indexed.filter(({ task }) => !task.active && !task.completed);
    const completed = indexed.filter(({ task }) => task.completed);
    const priority  = indexed.filter(({ task }) => task.priority && !task.completed);

    if (filter === "active") {
        if (active.length === 0) return "(no active tasks)";
        return `Active (${active.length}/10):\n${active.map(fmt).join("\n")}`;
    }
    if (filter === "backup") {
        if (backup.length === 0) return "(no backup tasks)";
        return `Backup (${backup.length}/40):\n${backup.map(fmt).join("\n")}`;
    }
    if (filter === "completed") {
        if (completed.length === 0) return "(no completed tasks)";
        return `Completed:\n${completed.map(fmt).join("\n")}`;
    }
    if (filter === "priority") {
        if (priority.length === 0) return "(no priority tasks)";
        return `Priority:\n${priority.map(fmt).join("\n")}`;
    }

    // Full list — all sections
    const parts: string[] = [];
    if (active.length > 0) {
        parts.push(`Active (${active.length}/10):\n${active.map(fmt).join("\n")}`);
    } else {
        parts.push("Active (0/10):\n(none)");
    }
    if (backup.length > 0) {
        parts.push(`Backup (${backup.length}/40):\n${backup.map(fmt).join("\n")}`);
    }
    if (completed.length > 0) {
        parts.push(`Completed:\n${completed.map(fmt).join("\n")}`);
    }
    return parts.join("\n\n");
}
