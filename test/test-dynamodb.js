// Comprehensive test script for DynamoDB functions
import assert from 'assert';
import { saveCheckIn, getRecordsForDate, getTasksForDate, batchUpdateTasks, deleteRecordsForDate } from '../src/services/dynamodb.js';

// Use a date from the distant past to avoid conflicts with real data
const TEST_DATE = "2000-01-01";

// Test helper to verify errors are thrown
async function assertThrows(fn, errorMessage) {
  try {
    await fn();
    throw new Error(`Expected error but none was thrown: ${errorMessage}`);
  } catch (error) {
    if (error.message.startsWith('Expected error')) {
      throw error;
    }
    // Error was thrown as expected
  }
}

// === INPUT VALIDATION TESTS ===
async function testInputValidation() {
  console.log("\n📋 Testing Input Validation...\n");

  const testTimestamp = Date.now();

  // Test invalid date
  await assertThrows(
    () => saveCheckIn("", testTimestamp, "task_list", []),
    "Empty date should throw error"
  );
  console.log("✅ Empty date rejected");

  await assertThrows(
    () => saveCheckIn(null, testTimestamp, "task_list", []),
    "Null date should throw error"
  );
  console.log("✅ Null date rejected");

  // Test invalid date format
  await assertThrows(
    () => saveCheckIn("2025/12/25", testTimestamp, "task_list", []),
    "Wrong separator should throw error"
  );
  console.log("✅ Wrong date separator rejected");

  await assertThrows(
    () => saveCheckIn("25-12-2025", testTimestamp, "task_list", []),
    "Wrong date order should throw error"
  );
  console.log("✅ Wrong date order rejected");

  await assertThrows(
    () => saveCheckIn("2025-1-5", testTimestamp, "task_list", []),
    "Missing leading zeros should throw error"
  );
  console.log("✅ Missing leading zeros rejected");

  await assertThrows(
    () => saveCheckIn("abcd-12-25", testTimestamp, "task_list", []),
    "Non-numeric year should throw error"
  );
  console.log("✅ Non-numeric year rejected");

  // Test invalid year
  await assertThrows(
    () => saveCheckIn("1999-12-25", testTimestamp, "task_list", []),
    "Year before 2000 should throw error"
  );
  console.log("✅ Year before 2000 rejected");

  // Test invalid month
  await assertThrows(
    () => saveCheckIn("2025-00-25", testTimestamp, "task_list", []),
    "Month 00 should throw error"
  );
  console.log("✅ Month 00 rejected");

  await assertThrows(
    () => saveCheckIn("2025-13-25", testTimestamp, "task_list", []),
    "Month 13 should throw error"
  );
  console.log("✅ Month 13 rejected");

  // Test invalid day
  await assertThrows(
    () => saveCheckIn("2025-12-00", testTimestamp, "task_list", []),
    "Day 00 should throw error"
  );
  console.log("✅ Day 00 rejected");

  await assertThrows(
    () => saveCheckIn("2025-12-32", testTimestamp, "task_list", []),
    "Day 32 should throw error"
  );
  console.log("✅ Day 32 rejected");

  // Test invalid timestamp
  await assertThrows(
    () => saveCheckIn(TEST_DATE, 0, "task_list", []),
    "Zero timestamp should throw error"
  );
  console.log("✅ Zero timestamp rejected");

  await assertThrows(
    () => saveCheckIn(TEST_DATE, -1, "task_list", []),
    "Negative timestamp should throw error"
  );
  console.log("✅ Negative timestamp rejected");

  // Test invalid type
  await assertThrows(
    () => saveCheckIn(TEST_DATE, testTimestamp, "invalid_type", []),
    "Invalid type should throw error"
  );
  console.log("✅ Invalid type rejected");

  // Test tasks not an array
  await assertThrows(
    () => saveCheckIn(TEST_DATE, testTimestamp, "task_list", "not an array"),
    "Non-array tasks should throw error"
  );
  console.log("✅ Non-array tasks rejected");

  // Test invalid task structure
  await assertThrows(
    () => saveCheckIn(TEST_DATE, testTimestamp, "task_list", [{ text: "valid", completed: "not a boolean", priority: true }]),
    "Invalid completed field should throw error"
  );
  console.log("✅ Invalid task structure rejected");

  // Test missing task fields
  await assertThrows(
    () => saveCheckIn(TEST_DATE, testTimestamp, "task_list", [{ completed: false, priority: true }]),
    "Missing task text should throw error"
  );
  console.log("✅ Missing task fields rejected");
}

// === SANITIZATION TESTS ===
async function testSanitization() {
  console.log("\n🧹 Testing Input Sanitization...\n");

  const testTimestamp = Date.now();

  // Test character sanitization
  await saveCheckIn(TEST_DATE, testTimestamp, "task_list", [
    { text: "workout<script>alert('xss')</script>", completed: false, priority: true },
    { text: "call mom; DROP TABLE CheckIns;--", completed: false, priority: false },
    { text: "groceries & laundry", completed: false, priority: false }
  ]);

  const taskRecord = await getTasksForDate(TEST_DATE);
  assert.strictEqual(taskRecord.tasks[0].text, "workoutscriptalert'xss'script", "HTML tags should be removed, apostrophes preserved");
  assert.strictEqual(taskRecord.tasks[1].text, "call mom DROP TABLE CheckIns", "SQL injection chars should be removed");
  assert.strictEqual(taskRecord.tasks[2].text, "groceries  laundry", "Ampersands should be removed");
  console.log("✅ Malicious characters sanitized");

  // Test allowed characters (overwrite existing task list)
  await saveCheckIn(TEST_DATE, testTimestamp + 1, "task_list", [
    { text: "it's mom's birthday! @gym +workout $100", completed: false, priority: true }
  ]);

  const allowedCharsRecord = await getTasksForDate(TEST_DATE);
  assert.strictEqual(allowedCharsRecord.tasks[0].text, "its moms birthday! @gym +workout $100", "Allowed special chars should remain");
  console.log("✅ Allowed characters preserved");
}

// === LENGTH LIMIT TESTS ===
async function testLengthLimits() {
  console.log("\n📏 Testing Length Limits...\n");

  const testTimestamp = Date.now();

  // Test max tasks (30) - overwrite existing task list
  const maxTasks = Array.from({ length: 30 }, (_, i) => ({
    text: `task${i}`,
    completed: false,
    priority: false
  }));
  await saveCheckIn(TEST_DATE, testTimestamp + 2, "task_list", maxTasks);
  const record = await getTasksForDate(TEST_DATE);
  assert.strictEqual(record.tasks.length, 30, "Should accept 30 tasks");
  console.log("✅ Max tasks (30) accepted");

  // Test too many tasks (31)
  const tooManyTasks = Array.from({ length: 31 }, (_, i) => ({
    text: `task${i}`,
    completed: false,
    priority: false
  }));
  await assertThrows(
    () => saveCheckIn(TEST_DATE, testTimestamp + 3, "task_list", tooManyTasks),
    "Too many tasks should throw error"
  );
  console.log("✅ Too many tasks (31) rejected");

  // Test task text length (500 chars max)
  const longText = "a".repeat(500);
  await saveCheckIn(TEST_DATE, testTimestamp + 4, "task_list", [
    { text: longText, completed: false, priority: false }
  ]);
  const longRecord = await getTasksForDate(TEST_DATE);
  assert.strictEqual(longRecord.tasks[0].text.length, 500, "Should accept 500 char task");
  console.log("✅ Max task length (500) accepted");

  // Test task text too long (501 chars)
  const tooLongText = "a".repeat(501);
  await assertThrows(
    () => saveCheckIn(TEST_DATE, testTimestamp + 5, "task_list", [
      { text: tooLongText, completed: false, priority: false }
    ]),
    "Too long task text should throw error"
  );
  console.log("✅ Too long task text (501) rejected");

  // Test message length (1000 chars max)
  const longMessage = "a".repeat(1000);
  await saveCheckIn(TEST_DATE, testTimestamp + 6, "user_input", [], longMessage);
  const msgRecords = await getRecordsForDate(TEST_DATE);
  const msgRecord = msgRecords.find(r => r.type === "user_input" && r.message.length === 1000);
  assert(msgRecord, "Should find user_input with 1000 char message");
  assert.strictEqual(msgRecord.message.length, 1000, "Should accept 1000 char message");
  console.log("✅ Max message length (1000) accepted");

  // Test message too long (1001 chars)
  const tooLongMessage = "a".repeat(1001);
  await assertThrows(
    () => saveCheckIn(TEST_DATE, testTimestamp + 7, "user_input", [], tooLongMessage),
    "Too long message should throw error"
  );
  console.log("✅ Too long message (1001) rejected");
}

// === RATE LIMITING TESTS ===
async function testRateLimiting() {
  console.log("\n⏱️  Testing Rate Limiting...\n");

  const baseTimestamp = Date.now();

  // Execute 100 operations (should succeed)
  // Note: We've already used some operations in previous tests, so adjust accordingly
  // Clear the date first to get accurate count
  await deleteRecordsForDate(TEST_DATE);

  for (let i = 0; i < 100; i++) {
    await saveCheckIn(TEST_DATE, baseTimestamp + i, "user_input", [], `message ${i}`);
  }
  console.log("✅ 100 operations succeeded");

  // 101st operation should fail
  await assertThrows(
    () => saveCheckIn(TEST_DATE, baseTimestamp + 100, "user_input", [], "message 100"),
    "101st operation should exceed rate limit"
  );
  console.log("✅ Rate limit enforced at 100 operations");
}

// === SAVE CHECKIN TESTS (3 TYPES) ===
async function testSaveCheckIn() {
  console.log("\n💾 Testing saveCheckIn (3 types)...\n");

  // Clear from rate limit test
  await deleteRecordsForDate(TEST_DATE);

  const baseTimestamp = Date.now();

  // Test 1: task_list type
  await saveCheckIn(TEST_DATE, baseTimestamp, "task_list", [
    { text: "workout", completed: false, priority: true },
    { text: "laundry", completed: false, priority: false }
  ]);
  const taskListRecords = await getRecordsForDate(TEST_DATE);
  const taskList = taskListRecords.find(r => r.type === "task_list");
  assert(taskList, "task_list record should exist");
  assert.strictEqual(taskList.tasks.length, 2, "Should have 2 tasks");
  console.log("✅ task_list saved");

  // Test 2: user_input type
  await saveCheckIn(TEST_DATE, baseTimestamp + 1, "user_input", [], "I finished laundry!");
  const userInputRecords = await getRecordsForDate(TEST_DATE);
  const userInput = userInputRecords.find(r => r.type === "user_input");
  assert(userInput, "user_input record should exist");
  assert.strictEqual(userInput.message, "I finished laundry!", "Message should match");
  console.log("✅ user_input saved");

  // Test 3: ai_output type
  await saveCheckIn(TEST_DATE, baseTimestamp + 2, "ai_output", [], "Great job on completing laundry!");
  const aiOutputRecords = await getRecordsForDate(TEST_DATE);
  const aiOutput = aiOutputRecords.find(r => r.type === "ai_output");
  assert(aiOutput, "ai_output record should exist");
  assert.strictEqual(aiOutput.message, "Great job on completing laundry!", "AI message should match");
  console.log("✅ ai_output saved");

  // Verify all 3 records exist for the date
  const allRecords = await getRecordsForDate(TEST_DATE);
  assert.strictEqual(allRecords.length, 3, "Should have 3 records for the date");
  console.log("✅ All 3 record types coexist");
}

// === READ TESTS ===
async function testReads() {
  console.log("\n📖 Testing Read Operations...\n");

  // Clear and start fresh
  await deleteRecordsForDate(TEST_DATE);

  const baseTimestamp = Date.now();

  // Save multiple records in specific order
  await saveCheckIn(TEST_DATE, baseTimestamp, "task_list", [
    { text: "task1", completed: false, priority: false }
  ]);
  await saveCheckIn(TEST_DATE, baseTimestamp + 1000, "user_input", [], "message1");
  await saveCheckIn(TEST_DATE, baseTimestamp + 2000, "ai_output", [], "response1");

  // Test getRecordsForDate (should return all in ascending timestamp order)
  const records = await getRecordsForDate(TEST_DATE);
  assert.strictEqual(records.length, 3, "Should have 3 records");
  assert.strictEqual(records[0].timestamp, baseTimestamp, "First record should be earliest");
  assert.strictEqual(records[2].timestamp, baseTimestamp + 2000, "Last record should be latest");
  console.log("✅ getRecordsForDate returns sorted records");

  // Test getTasksForDate
  const taskRecord = await getTasksForDate(TEST_DATE);
  assert(taskRecord, "Task record should exist");
  assert.strictEqual(taskRecord.type, "task_list", "Should be task_list type");
  assert.strictEqual(taskRecord.tasks[0].text, "task1", "Should return correct task");
  console.log("✅ getTasksForDate returns task_list record");
}

// === BATCH UPDATE TESTS ===
async function testBatchUpdates() {
  console.log("\n🔄 Testing Batch Updates...\n");

  // Clear and start fresh
  await deleteRecordsForDate(TEST_DATE);

  const testTimestamp = Date.now();

  // Setup initial task list
  await saveCheckIn(TEST_DATE, testTimestamp, "task_list", [
    { text: "workout", completed: false, priority: false },      // 0
    { text: "laundry", completed: false, priority: false },      // 1
    { text: "groceries", completed: false, priority: false },    // 2
    { text: "call mom", completed: true, priority: true },       // 3
    { text: "read book", completed: false, priority: true }      // 4
  ]);

  // Test comprehensive batch update (all operations)
  const updatedTasks = await batchUpdateTasks(TEST_DATE, {
    complete: [0, 1],                                           // complete workout, laundry
    uncomplete: [3],                                            // uncomplete call mom
    updateText: [{ index: 2, text: "groceries at Whole Foods" }],  // update groceries text
    makePriority: [1],                                          // make laundry priority
    unmakePriority: [4],                                        // unmake read book priority
    remove: [4],                                                // remove read book
    add: ["clean room", "meal prep"]                            // add 2 new tasks
  });

  assert.strictEqual(updatedTasks.length, 6, "Should have 6 tasks (5 - 1 removed + 2 added)");
  assert.strictEqual(updatedTasks[0].completed, true, "Workout should be completed");
  assert.strictEqual(updatedTasks[1].completed, true, "Laundry should be completed");
  assert.strictEqual(updatedTasks[1].priority, true, "Laundry should be priority");
  assert.strictEqual(updatedTasks[2].text, "groceries at Whole Foods", "Groceries text should be updated");
  assert.strictEqual(updatedTasks[3].completed, false, "Call mom should be uncompleted");
  assert.strictEqual(updatedTasks[4].text, "clean room", "First new task should be added");
  assert.strictEqual(updatedTasks[5].text, "meal prep", "Second new task should be added");
  console.log("✅ Comprehensive batch update successful");

  // Verify persistence
  const persistedRecord = await getTasksForDate(TEST_DATE);
  assert.strictEqual(persistedRecord.tasks.length, 6, "Updates should persist");
  assert.strictEqual(persistedRecord.timestamp, testTimestamp, "Original timestamp should be preserved");
  console.log("✅ Batch updates persisted with original timestamp");

  // Test order of operations edge cases - create new task list
  await deleteRecordsForDate(TEST_DATE);
  await saveCheckIn(TEST_DATE, testTimestamp + 1, "task_list", [
    { text: "task1", completed: false, priority: false },
    { text: "task2", completed: false, priority: false },
    { text: "task3", completed: false, priority: false }
  ]);

  // Remove index 1, then add - should work correctly
  const result = await batchUpdateTasks(TEST_DATE, {
    complete: [1],      // complete task2
    remove: [1],        // then remove task2 (should happen after completion)
    add: ["task4"]      // then add task4
  });

  assert.strictEqual(result.length, 3, "Should have 3 tasks (3 - 1 + 1)");
  assert.strictEqual(result[0].text, "task1", "Task1 should still be first");
  assert.strictEqual(result[1].text, "task3", "Task3 should shift to index 1");
  assert.strictEqual(result[2].text, "task4", "Task4 should be added last");
  console.log("✅ Batch update order of operations correct");

  // Test invalid batch updates
  await assertThrows(
    () => batchUpdateTasks(TEST_DATE, { complete: "not an array" }),
    "Non-array complete should throw error"
  );
  console.log("✅ Invalid batch update rejected");

  await assertThrows(
    () => batchUpdateTasks(TEST_DATE, { complete: [1.5] }),
    "Non-integer index should throw error"
  );
  console.log("✅ Non-integer index rejected");

  await assertThrows(
    () => batchUpdateTasks(TEST_DATE, { add: [123] }),
    "Non-string add should throw error"
  );
  console.log("✅ Non-string add rejected");
}

// === CLEANUP FUNCTION ===
async function cleanupTestData() {
  console.log("\n🧹 Cleaning up test data...\n");

  const deletedCount = await deleteRecordsForDate(TEST_DATE);
  if (deletedCount > 0) {
    console.log(`✅ Deleted ${deletedCount} record(s) for ${TEST_DATE}`);
  } else {
    console.log(`✅ No records to delete for ${TEST_DATE}`);
  }
}

// === MAIN TEST RUNNER ===
async function runAllTests() {
  console.log("🧪 Starting Comprehensive DynamoDB Tests...");
  console.log(`📅 Using test date: ${TEST_DATE}\n`);

  try {
    await testInputValidation();
    await testSanitization();
    await testLengthLimits();
    await testRateLimiting();
    await testSaveCheckIn();
    await testReads();
    await testBatchUpdates();

    console.log("\n🎉 All comprehensive tests passed!\n");

    // Cleanup test data
    await cleanupTestData();

  } catch (error) {
    console.error("\n❌ Test failed:", error.message);
    console.error(error);
    process.exit(1);
  }
}

runAllTests();
