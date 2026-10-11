// Loads bot.json (bot root): your home server, your user ID, which commands start as beta.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'bot.json');
let json = {};
if (fs.existsSync(file)) {
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`bot.json is not valid JSON: ${e.message}`); process.exit(1); }
}

const SERVER_ID = String(json.serverId ?? '1557993007876407416');
const OWNER_ID = String(json.userId ?? '638740465872666636');
// Commands that are beta until you run "!config public <command>". Anything not listed starts public.
const DEFAULT_BETA = new Set((Array.isArray(json.defaultBeta) ? json.defaultBeta : ['trigger', 'emoji']).map((n) => String(n).toLowerCase()));

module.exports = { SERVER_ID, OWNER_ID, DEFAULT_BETA };
