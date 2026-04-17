import { handleWebhook } from '../handlers/webhook.js';
import dotenv from 'dotenv';
import { APIGatewayProxyEvent } from 'aws-lambda';


dotenv.config()
console.log('starting test...')

const mockEvent = {
  body: JSON.stringify({
    message: {
      text: "I finished my workout",
      chat: { id: process.env.YOUR_TELEGRAM_CHAT_ID }
    }
  }),
  requestContext: {}
};

handleWebhook(mockEvent as APIGatewayProxyEvent)
  .then(() => console.log("Done"))
  .catch((err) => console.error("Error:", err));
