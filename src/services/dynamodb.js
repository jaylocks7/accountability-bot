import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

export const main = async () => {
  const command = new PutCommand({
    TableName: "CheckIns",
    Item: {
      CommonName: "Shiba Inu",
    },
  });

  const response = await docClient.send(command);
  console.log(response);
  return response;
};


//WRITE
async function saveCheckIn(date, timestamp, type, tasks) {
    const input = {
        Item: {
            date: {
            S: date
            },
            timestamp: {
            I: timestamp
            },
            SongTitle: {
            S: "Call Me Today"
            }
        },
        ReturnConsumedCapacity: "TOTAL",
        TableName: "CheckIns"
    };
    const command = new PutItemCommand(input);
    const response = await client.send(command);
  return number * number;
}

//READ
async function getRecordsForDate(date) {
  return number * number;
}

//BATCH.UPDATE
async function updateTaskStatus(date, timestamp, taskIndices, taskStatuses) {
  return number * number;
}

