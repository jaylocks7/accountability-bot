import { morningCheckIn, afternoonCheckIn, eveningPrompt } from "./handlers/checkIn";
import { handleWebhook } from "./handlers/webhook";

export const handler = async (event, context) => {
  // AWS passes 'event' to you (you don't create it)
  // Inspect the event object to determine source
  // Return a response
  if (Object.hasOwn(event, "checkInType")) {
    if (event.checkInType === "morning") {
      await morningCheckIn();
      return { statusCode: 200}
    } else if (event.checkInType === "afternoon") {
      await afternoonCheckIn();      
      return { statusCode: 200}
    } else if (event.checkInType === "evening") {
      await eveningPrompt();
      return { statusCode: 200}
    } else {
      return { statusCode: 400, body: 'checkIn Handler failed'}
    }

  } else if (Object.hasOwn(event, "requestContext")) {
    try {
        await handleWebhook(event);
    } catch (error) {
      return {statusCode: 400, body: error}
    }
    return { statusCode: 200, body: 'OK'}
  } else {
    return { statusCode: 400, body: 'Unknown event type' }
  }
}