import { getTasksForDate, batchUpdateTasks } from "../services/dynamodb";
import Anthropic from '@anthropic-ai/sdk';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { sendMessage } from "../services/telegram";


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
}
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
        return `${index}. ${checkbox} ${star} ${taskText}`
    });

    const result = formattedTasks.join('\n');

    const systemPrompt = `
        You are a friendly but firm accountability coach helping users manage their daily tasks.

        Current tasks are shown in this format:
        [index]. [done!] [*] [task text]
        - Index: 0, 1, 2, ...
        - "done!" = completed
        - "*" = priority

        Your role:
        - Celebrate completions enthusiastically
        - Encourage progress
        - Update tasks immediately using available tools

        Tool usage:
        - When user says they completed/finished/did task(s), immediately use complete_tasks tool with the task indices
        - Don't just acknowledge - actually call the tool to update tasks
        - Don't ask permission - just do it

        Response guidelines:
        - Keep responses 2-3 sentences max
        - Be actionable and celebratory for wins
        - Acknowledge what was updated after using a tool
        - Redirect off-topic conversations back to tasks
    `;

    //const api_key = process.env.ANTHROPIC_API_KEY;

    const client = new Anthropic()

    const msg_to_ai = `${result}\n${userMessage}`

    const response = await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
            { role: "user", content: msg_to_ai}
        ],
        tools: tools
    })

    let text;

    console.log("stop_reason:", response.stop_reason);
    console.log("response content:", JSON.stringify(response.content, null, 2));


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
                        case "complete_tasks":
                            // call batchUpdateTasks with completed: true
                            const input = block.input as { task_indices: number[] };
                            const indices = input.task_indices;
                            try {
                                await batchUpdateTasks(date, { complete: indices })
                            } catch (error) {
                                throw new Error(`Tool Call complete_tasks failed to update tasks: ${error}`);
                            }
                    }
                }

            }
    }


    if (!text) {
        throw new Error('Missing text from Claude response.content');
    }

    await sendMessage(chatId, text)


    return;
}

export { handleWebhook };