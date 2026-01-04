// Test script for Telegram sendMessage function
import dotenv from 'dotenv';
import { sendMessage } from '../src/services/telegram.js';

// Load environment variables from .env file
dotenv.config();

async function testTelegram() {
  console.log("🧪 Starting Telegram tests...\n");

  // Your chat ID from .env
  const chatId = process.env.YOUR_TELEGRAM_CHAT_ID;

  try {
    // Test 1: Send a simple message
    console.log("1️⃣ Testing sendMessage with simple text...");
    const result1 = await sendMessage(chatId, "Hello from the test script! 👋");

    if (result1.success) {
      console.log("✅ Message sent successfully!");
      console.log("   Message ID:", result1.data.result.message_id);
    } else {
      console.error("❌ Failed to send message:", result1.error);
    }
    console.log();

    // Test 2: Send a message with Markdown formatting
    console.log("2️⃣ Testing sendMessage with Markdown...");
    const result2 = await sendMessage(
      chatId,
      "*Bold text* and _italic text_ and `code`",
      { parse_mode: 'Markdown' }
    );

    if (result2.success) {
      console.log("✅ Formatted message sent successfully!");
    } else {
      console.error("❌ Failed to send formatted message:", result2.error);
    }
    console.log();

    // Test 3: Test validation - empty text
    console.log("3️⃣ Testing validation with empty text...");
    try {
      await sendMessage(chatId, "");
      console.error("❌ Should have thrown error for empty text");
    } catch (error) {
      console.log("✅ Correctly rejected empty text:", error.message);
    }
    console.log();

    // Test 4: Test validation - missing chatId
    console.log("4️⃣ Testing validation with missing chatId...");
    try {
      await sendMessage(null, "Test message");
      console.error("❌ Should have thrown error for missing chatId");
    } catch (error) {
      console.log("✅ Correctly rejected missing chatId:", error.message);
    }
    console.log();

    // Test 5: Test long message (over 4096 chars)
    console.log("5️⃣ Testing validation with long message...");
    const longText = "a".repeat(5000);
    try {
      await sendMessage(chatId, longText);
      console.error("❌ Should have thrown error for message over 4096 chars");
    } catch (error) {
      console.log("✅ Correctly rejected long message:", error.message);
    }
    console.log();

    console.log("🎉 All tests completed!");

  } catch (error) {
    console.error("❌ Unexpected error:", error);
  }
}

testTelegram();
