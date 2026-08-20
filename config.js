require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID  = process.env.GROUP_ID;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN não definido no .env');

module.exports = { BOT_TOKEN, GROUP_ID: Number(GROUP_ID) };
