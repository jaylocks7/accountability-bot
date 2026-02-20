//import { getTasksForDate, } from '../services/dynamodb.js';

async function morningCheckIn() {
    //const tasks = await getTasksForDate(new Date());
    return "Good morning! How are you feeling today?";
    }

function afternoonCheckIn() {
    return "Good afternoon! How has your day been so far?";
    }

function eveningPrompt() {
    return "Good evening! What are your plans for tomorrow?";
    }

export { morningCheckIn, afternoonCheckIn, eveningPrompt };