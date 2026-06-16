import { getTasksForDate, batchUpdateTasks } from "../services/dynamodb.js";
import Anthropic from '@anthropic-ai/sdk';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { sendMessage } from "../services/telegram.js";
import dotenv from 'dotenv';
dotenv.config();
console.log("API key loaded:", !!process.env.ANTHROPIC_API_KEY);




const tools: Anthropic.Messages.ToolUnion[] = [
    {
        "name": "complete_tasks",
        "description": "Mark one or more tasks as completed",
        "input_schema": {
            "type": "object",
            "properties": {
                "task_indices": {
                    "type": "array",
                    "items": {
                        "type": "number"
                    },
                    "description": "Array of zero-based task indices to mark as complete (e.g., [0, 2, 5])"
                }
            },
            "required": ["task_indices"]
        }
    },
    {
        "name": "uncomplete_tasks",
        "description": "Mark one or more tasks as incomplete",
        "input_schema": {
            "type": "object",
            "properties": {
                "tasks_indices": {
                    "type": "array",
                    "items": {
                        "type": "number"
                    },
                    "description": "Array of zero-based task indices to mark as incomplete (e.g., [0, 2, 5])"
                }
            },
            "required": ["tasks_indices"]
        }
    },
    {
        "name": "add_tasks",
        "description": "Add one or more tasks to tasks list",
        "input_schema": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "Array of strings representing to-do list tasks to add to the running to-do list"
                }
            },
            "required": ["tasks"]
        }
    },
    {
        "name": "remove_tasks",
        "description": "Remove one or more tasks to tasks list",
        "input_schema": {
            "type": "object",
            "properties": {
                "tasks_indices": {
                    "type": "array",
                    "items": {
                        "type": "number"
                    },
                    "description": "Array of zero-based task indices to pertaining to tasks to delete (e.g., [0, 2, 5])"
                }
            },
            "required": ["tasks_indices"]
        }
    },
    {
        "name": "set_priority",
        "description": "Mark one or more tasks as priority",
        "input_schema": {
            "type": "object",
            "properties": {
                "tasks_indices": {
                    "type": "array",
                    "items": {
                        "type": "number"
                    },
                    "description": "Array of zero-based task indices to pertaining to tasks to set priority to true (e.g., [0, 2, 5])"
                }
            },
            "required": ["tasks_indices"]
        }
    },
    {
        "name": "unset_priority",
        "description": "Mark one or more tasks as not priority",
        "input_schema": {
            "type": "object",
            "properties": {
                "tasks_indices": {
                    "type": "array",
                    "items": {
                        "type": "number"
                    },
                    "description": "Array of zero-based task indices to pertaining to tasks to set priority to false (e.g., [0, 2, 5])"
                }
            },
            "required": ["tasks_indices"]
        }
    },
]

/*
const mockEvent = {
  body: JSON.stringify({
    message: {
      text: "Mark task 0 as complete",
      chat: { id: "YOUR_CHAT_ID" }
    }
  }),
  requestContext: {} // Needed for Lambda router
};
*/

const client = new Anthropic()

async function formatTasks(date: string) {
    let taskRecord;
    try {
        taskRecord = await getTasksForDate(date);
    } catch (error) {
        throw new Error(`Failed to fetch tasks: ${error}`);
    }
    const tasks = taskRecord?.tasks || [];


    const formattedTasks = tasks.map((task: Record<string, any>, index: number) => {
        const checkbox = task?.completed ? 'done! ': '';
        const star = task?.priority ? '* ': '';
        const taskText = task?.text;
        return `${index}. ${checkbox} ${taskText} ${star}`
    });

    const result = formattedTasks.join('\n');

    return result;
}


async function handleWebhook(event: APIGatewayProxyEvent) {
    if (!event.body) {
        throw new Error('Missing request body');
    }
    const body = JSON.parse(event.body);
    const message = body.message;

    if (!message?.text || !message?.chat) {
        throw new Error('Invalid message format');
    }
    const userMessage = message.text;
    const chatId = message.chat.id.toString();

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const date = formatter.format(new Date());
    // "2026-03-10" (in Pacific time)

    const result = await formatTasks(date);

    const systemPrompt = `
        You are a friendly but firm accountability coach helping users manage their daily tasks.

        Current tasks are shown in this format:
        [index]. [done!] [task text] [*]
        - Index: 0, 1, 2, ...
        - "done!" = completed
        - "*" = priority

        Your role:
        - Celebrate completions enthusiastically
        - Encourage progress
        - Update tasks immediately using available tools

        Tool usage:
        - When user says they completed/finished/did task(s), immediately use complete_tasks tool with the task indices
        - When user says they want to make completed task(s) as incomplete, immediately use uncomplete_tasks tool with the task indices
        - When user wants to add a new task(s), immediately use add_tasks tool with the task(s) to add
        - When user wants to delete a task(s) from the list, immediately use remove_tasks tool with the task indices
        - When user wants to set priority of task(s) to true, immediately use set_priority tool with the task indices
        - When user wants to set priority of task(s) to false, immediately use unset_priority tool with the task indices
        - Don't just acknowledge - actually call the tool to update tasks
        - Don't ask permission - just do it

        Response guidelines:
        - Keep responses 2-3 sentences max
        - Be actionable and celebratory for wins
        - Acknowledge what was updated after using a tool
        - Redirect off-topic conversations back to tasks
    `;

    const msgToAI = `${result}\n${userMessage}`

    const response = await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
            { role: "user", content: msgToAI}
        ],
        tools: tools
    })

    let text;

    console.log("stop_reason:", response.stop_reason);
    console.log("response content:", JSON.stringify(response.content, null, 2));
    const toolResults = [];

    if (response.stop_reason === "max_tokens") {
        throw new Error("Claude response was cut off — increase max_tokens");
    } else if (response.stop_reason === "end_turn") {
        const textBlock = response.content.find(block => block.type === "text");
        if (textBlock && textBlock.type === "text") {
            text = textBlock.text;
        }

    } else if (response.stop_reason === "tool_use") {
        for (const block of response.content) {
            if (block.type === "tool_use") {
                switch (block.name) {
                    case "complete_tasks": {
                        // call batchUpdateTasks with completed: true
                        const input = block.input as { task_indices: number[] };
                        const indices = input.task_indices;
                        try {
                            await batchUpdateTasks(date, { complete: indices })
                        } catch (error) {
                            throw new Error(`Tool Call complete_tasks failed to update tasks: ${error}`);
                        }
                        break;
                    }
                    case "uncomplete_tasks": {
                        // call batchUpdateTasks with completed: true
                        const input = block.input as { tasks_indices: number[] };
                        const indices = input.tasks_indices;
                        try {
                            await batchUpdateTasks(date, { uncomplete: indices })
                        } catch (error) {
                            throw new Error(`Tool Call uncomplete_tasks failed to update tasks: ${error}`);
                        }
                        break;
                    }
                    case "add_tasks": {
                        const input = block.input as { tasks: string[] };
                        const tasks = input.tasks
                        try {
                            await batchUpdateTasks(date, { add: tasks })
                        } catch (error) {
                            throw new Error(`Tool Call add_tasks failed to update tasks: ${error}`);
                        }
                        break;
                    }
                    case "remove_tasks": {
                        const input = block.input as { tasks_indices: number[] };
                        const indices = input.tasks_indices
                        try {
                            await batchUpdateTasks(date, { remove: indices })
                        } catch (error) {
                            throw new Error(`Tool Call remove_tasks failed to update tasks: ${error}`);
                        }
                        break;
                    }
                    case "set_priority": {
                        const input = block.input as { tasks_indices: number[] };
                        const indices = input.tasks_indices;
                        try {
                            await batchUpdateTasks(date, { makePriority: indices });
                        } catch (error) {
                            throw new Error(`Tool Call set_priority failed to update tasks: ${error}`);
                        }
                        break;
                    }
                    case "unset_priority": {
                        const input = block.input as { tasks_indices: number[] };
                        const indices = input.tasks_indices;
                        try {
                            await batchUpdateTasks(date, { unmakePriority: indices });
                        } catch (error) {
                            throw new Error(`Tool Call unset_priority failed to update tasks: ${error}`);
                        }
                        break;
                    }
                }
                const updatedTasks = await formatTasks(date);
                toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: `Tasks updated. Current list:\n${updatedTasks}`
                });

                
            }
        }
        const messages: Anthropic.Messages.MessageParam[] = [
            {
                role: "user",
                content: msgToAI
            },
            {
                role: "assistant",
                content: response.content
            },
            {
                role: "user",
                content: toolResults as Anthropic.Messages.ToolResultBlockParam[]
            }
        ]

        const secondResponse = await client.messages.create({
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 1024,
            system: systemPrompt,
            messages: messages,
            tools: tools
        })

        const textBlock = secondResponse.content.find(block => block.type === "text");
        if (textBlock && textBlock.type === "text") {
            text = textBlock.text;
        }
    }


    if (!text) {
        throw new Error('Missing text from Claude response.content');
    }

    await sendMessage(chatId, text)

    return;
}

export { handleWebhook };