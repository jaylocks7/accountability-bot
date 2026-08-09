import { dispatcher, workerHandler } from "./handlers/checkIn.js";
import { handleWebhook } from "./handlers/webhook.js";

export const handler = async (event: any, _context: any) => {
    // SQS worker: process check-in records
    if (event.Records?.[0]?.eventSource === "aws:sqs") {
        return workerHandler(event.Records);
    }

    // EventBridge hourly tick: dispatch check-ins
    if (event.checkInType === "tick") {
        await dispatcher();
        return { statusCode: 200 };
    }

    // Telegram webhook via API Gateway HTTP API
    if (event.requestContext) {
        try {
            await handleWebhook(event);
        } catch (error) {
            console.error("handleWebhook error:", error);
        }
        return { statusCode: 200, body: "OK" };
    }

    return { statusCode: 400, body: "Unknown event type" };
};
