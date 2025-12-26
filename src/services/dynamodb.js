import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, QueryCommand, UpdateCommand, DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// Rate limiting tracking (in-memory, resets on Lambda cold start)
const rateLimitMap = new Map(); // key: date, value: { count, resetTime }
const RATE_LIMIT_MAX = 100; // max operations per minute per date
const RATE_LIMIT_WINDOW = 60000; // 1 minute in ms

// Helper function to sanitize text
function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  // Allow: alphanumeric, apostrophe, !, @, $, +, space
  return text.replace(/[^a-zA-Z0-9'\s!@$+]/g, '').trim();
}

// Helper function to check rate limit
function checkRateLimit(date) {
  const now = Date.now();
  const limitData = rateLimitMap.get(date);

  if (!limitData || now > limitData.resetTime) {
    // Reset or initialize
    rateLimitMap.set(date, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return;
  }

  if (limitData.count >= RATE_LIMIT_MAX) {
    throw new Error(`Rate limit exceeded for ${date}. Max ${RATE_LIMIT_MAX} operations per minute.`);
  }

  limitData.count++;
}

//WRITE
//Case 1 -- end of day check in to get task list for next day
//Case 2 -- save a user msg to agent (ie i finished laundry!)
//Case 3 -- save an agent response to user
async function saveCheckIn(date, timestamp, type, tasks = [], message = "") {
    //tasks: [
    // {text: "workout", completed: false, priority: true},
    //]

    // Validate required fields
    if (!date || typeof date !== 'string') {
        throw new Error('Invalid date: must be a non-empty string');
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        throw new Error('Invalid date format: must be YYYY-MM-DD');
    }

    // Validate date components
    const [year, month, day] = date.split('-').map(Number);
    if (year < 2000) {
        throw new Error('Invalid year: must be 2000 or later');
    }
    if (month < 1 || month > 12) {
        throw new Error('Invalid month: must be between 01 and 12');
    }
    if (day < 1 || day > 31) {
        throw new Error('Invalid day: must be between 01 and 31');
    }

    if (!timestamp || typeof timestamp !== 'number' || timestamp <= 0) {
        throw new Error('Invalid timestamp: must be a positive number');
    }

    const validTypes = ['task_list', 'ai_output', 'user_input'];
    if (!validTypes.includes(type)) {
        throw new Error(`Invalid type: must be one of ${validTypes.join(', ')}`);
    }

    // Rate limiting
    checkRateLimit(date);

    // Validate and sanitize tasks array
    if (tasks && !Array.isArray(tasks)) {
        throw new Error('Tasks must be an array');
    }

    if (tasks.length > 30) {
        throw new Error('Too many tasks: maximum 30 tasks per list');
    }

    if (tasks.length > 0) {
        tasks = tasks.map((task, index) => {
            if (!task || typeof task !== 'object') {
                throw new Error(`Task ${index} must be an object`);
            }
            if (!task.text || typeof task.text !== 'string') {
                throw new Error(`Task ${index} missing or invalid text field`);
            }
            if (typeof task.completed !== 'boolean') {
                throw new Error(`Task ${index} missing or invalid completed field`);
            }
            if (typeof task.priority !== 'boolean') {
                throw new Error(`Task ${index} missing or invalid priority field`);
            }

            // Sanitize and validate length
            const sanitizedText = sanitizeText(task.text);
            if (sanitizedText.length === 0) {
                throw new Error(`Task ${index} text is empty after sanitization`);
            }
            if (sanitizedText.length > 500) {
                throw new Error(`Task ${index} text too long: maximum 500 characters`);
            }

            return {
                text: sanitizedText,
                completed: task.completed,
                priority: task.priority
            };
        });
    }

    // Validate and sanitize message
    if (message && typeof message !== 'string') {
        throw new Error('Message must be a string');
    }

    if (message) {
        message = sanitizeText(message);
        if (message.length > 1000) {
            throw new Error('Message too long: maximum 1000 characters');
        }
    }

    const item = {
        date: date,
        timestamp: timestamp,
        type: type
    }

    // Add optional fields based on type
    if (tasks.length > 0) {
        item.tasks = tasks;
    }
    if (message) {
        item.message = message;
    }

    const command = new PutCommand({
        TableName: "CheckIns",
        Item: item
    });

    const response = await docClient.send(command);
    console.log(response);
    return response;
}

//READ
async function getRecordsForDate(date) {
  const command = new QueryCommand({
    TableName: "CheckIns",
    KeyConditionExpression: "#date = :dateValue",
    ExpressionAttributeNames: {
      "#date": "date"
    },
    ExpressionAttributeValues: {
      ":dateValue": date
    }
  });

  const response = await docClient.send(command);
  return response.Items;
}

//SPECIFIC READ
async function getTasksForDate(date) {
  const records = await getRecordsForDate(date);
  return records.find(r => r.type === "task_list");
}

//BATCH UPDATE
async function batchUpdateTasks(date, updates) {
  // updates = {
  //   complete: [0, 2],           // task indices to mark complete
  //   uncomplete: [1],            // task indices to mark incomplete
  //   add: ["call mom"],          // new tasks to add (as strings)
  //   remove: [5],                // task indices to remove
  //   updateText: [{index: 0, text: "workout at gym"}],  // update task message
  //   makePriority: [1, 3],       // task indices to mark as priority
  //   unmakePriority: [2]         // task indices to unmark as priority
  // }

  // Validate date
  if (!date || typeof date !== 'string') {
    throw new Error('Invalid date: must be a non-empty string');
  }

  // Rate limiting
  checkRateLimit(date);

  // Validate updates object
  if (!updates || typeof updates !== 'object') {
    throw new Error('Updates must be an object');
  }

  // Validate index arrays (arrays of numbers)
  const indexArrays = ['complete', 'uncomplete', 'makePriority', 'unmakePriority', 'remove'];
  indexArrays.forEach(key => {
    if (updates[key] !== undefined) {
      if (!Array.isArray(updates[key])) {
        throw new Error(`${key} must be an array`);
      }
      updates[key].forEach(index => {
        if (!Number.isInteger(index) || index < 0) {
          throw new Error(`${key} contains invalid index: ${index} (must be non-negative integer)`);
        }
      });
    }
  });

  // Validate and sanitize add array (array of strings)
  if (updates.add !== undefined) {
    if (!Array.isArray(updates.add)) {
      throw new Error('add must be an array');
    }
    updates.add = updates.add.map((text, i) => {
      if (typeof text !== 'string') {
        throw new Error(`add[${i}] must be a string`);
      }
      const sanitized = sanitizeText(text);
      if (sanitized.length === 0) {
        throw new Error(`add[${i}] is empty after sanitization`);
      }
      if (sanitized.length > 500) {
        throw new Error(`add[${i}] too long: maximum 500 characters`);
      }
      return sanitized;
    });
  }

  // Validate and sanitize updateText array
  if (updates.updateText !== undefined) {
    if (!Array.isArray(updates.updateText)) {
      throw new Error('updateText must be an array');
    }
    updates.updateText = updates.updateText.map((update, i) => {
      if (!update || typeof update !== 'object') {
        throw new Error(`updateText[${i}] must be an object`);
      }
      if (!Number.isInteger(update.index) || update.index < 0) {
        throw new Error(`updateText[${i}] has invalid index (must be non-negative integer)`);
      }
      if (!update.text || typeof update.text !== 'string') {
        throw new Error(`updateText[${i}] missing or invalid text field`);
      }
      const sanitized = sanitizeText(update.text);
      if (sanitized.length === 0) {
        throw new Error(`updateText[${i}] text is empty after sanitization`);
      }
      if (sanitized.length > 500) {
        throw new Error(`updateText[${i}] text too long: maximum 500 characters`);
      }
      return {
        index: update.index,
        text: sanitized
      };
    });
  }

  // Step 1: Get current task list
  const taskRecord = await getTasksForDate(date);
  if (!taskRecord || !taskRecord.tasks) {
    throw new Error(`No task list found for ${date}`);
  }

  let tasks = [...taskRecord.tasks];

  // Step 2: Apply all updates

  // Mark tasks as complete
  if (updates.complete?.length > 0) {
    updates.complete.forEach(index => {
      if (tasks[index]) {
        tasks[index].completed = true;
      }
    });
  }

  // Mark tasks as incomplete
  if (updates.uncomplete?.length > 0) {
    updates.uncomplete.forEach(index => {
      if (tasks[index]) {
        tasks[index].completed = false;
      }
    });
  }

  // Update task text/message
  if (updates.updateText?.length > 0) {
    updates.updateText.forEach(update => {
      if (tasks[update.index]) {
        tasks[update.index].text = update.text;
      }
    });
  }

  // Mark as priority
  if (updates.makePriority?.length > 0) {
    updates.makePriority.forEach(index => {
      if (tasks[index]) {
        tasks[index].priority = true;
      }
    });
  }

  // Unmark as priority
  if (updates.unmakePriority?.length > 0) {
    updates.unmakePriority.forEach(index => {
      if (tasks[index]) {
        tasks[index].priority = false;
      }
    });
  }

  // Remove tasks (do this AFTER other modifications, before adding)
  if (updates.remove?.length > 0) {
    // Sort in descending order to remove from end first (prevents index shifting)
    const sortedIndices = [...updates.remove].sort((a, b) => b - a);
    sortedIndices.forEach(index => {
      if (index >= 0 && index < tasks.length) {
        tasks.splice(index, 1);
      }
    });
  }

  // Add new tasks (already sanitized above)
  if (updates.add?.length > 0) {
    updates.add.forEach(taskText => {
      tasks.push({
        text: taskText,
        completed: false,
        priority: false  // new tasks default to non-priority
      });
    });
  }

  // Validate final task count
  if (tasks.length > 30) {
    throw new Error('Too many tasks after update: maximum 30 tasks per list');
  }

  // Step 3: Update the existing record (keeps original timestamp)
  const command = new UpdateCommand({
    TableName: "CheckIns",
    Key: {
      date: date,
      timestamp: taskRecord.timestamp  // Original timestamp preserved
    },
    UpdateExpression: "SET tasks = :tasks",
    ExpressionAttributeValues: {
      ":tasks": tasks
    }
  });

  await docClient.send(command);
  return tasks;
}

//DELETE - for cleanup/testing purposes
async function deleteRecordsForDate(date) {
  // Get all records for the date
  const records = await getRecordsForDate(date);

  // Delete each record
  for (const record of records) {
    const command = new DeleteCommand({
      TableName: "CheckIns",
      Key: {
        date: record.date,
        timestamp: record.timestamp
      }
    });
    await docClient.send(command);
  }

  return records.length;
}

// Export functions
export { saveCheckIn, getRecordsForDate, getTasksForDate, batchUpdateTasks, deleteRecordsForDate };

