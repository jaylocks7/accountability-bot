import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Send a message to a Telegram chat
 * @param {number|string} chatId - The chat ID to send the message to
 * @param {string} text - The message text to send
 * @param {object} options - Optional parameters (parse_mode, reply_markup, etc.)
 * @returns {Promise<object>} - The Telegram API response
 */
async function sendMessage(chatId: string, text: string, options = {}) {
  // Validate inputs
  if (!chatId) {
    throw new Error('chatId is required');
  }

  if (!BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is not set');
  }

  // Telegram message length limit is 4096 characters
  if (text.length > 4096) {
    throw new Error('Message text exceeds Telegram limit of 4096 characters');
  }

  // Construct the API URL
  const url = `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`;

  // Prepare the payload
  const payload = {
    chat_id: chatId,
    text: text,
    ...options  // Spread any additional options (parse_mode, reply_markup, etc.)
  };

  try {
    // Make the HTTP POST request
    const response = await axios.post(url, payload);

    // Return the response data
    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    // Handle errors from Telegram API
    const errorMessage = error instanceof Error
      ? error.message
      : String(error);

    console.error('Telegram API error:', errorMessage);

    return {
      success: false,
      error: errorMessage
    };
  }
}

export { sendMessage };
