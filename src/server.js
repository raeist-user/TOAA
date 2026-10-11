require('dotenv').config();
const missing = ['CLIENT_ID', 'CLIENT_SECRET', 'MONGODB_URI', 'SESSION_SECRET'].filter((k) => !process.env[k]);
if (!process.env.CALLBACK_URL && !process.env.RENDER_EXTERNAL_URL) missing.push('CALLBACK_URL');
if (missing.length) { console.error(`Missing environment variables: ${missing.join(', ')}`); process.exit(1); }

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const mongoose = require('mongoose');
const path = require('path');
const { Feed, CountryGuessConfig, WordStoryConfig, WordChainConfig, TriggerConfig, EmojiConfig, FeatureFlag, BetaGuild, WebJob, GuildInfo } = require('./models');
const { SERVER_ID, DEFAULT_BETA } = require('./botconfig'); // from bot.json

// The OAuth2 redirect must match, character for character, one of the Redirects in
// Discord Developer Portal > OAuth2. Normalise whatever is in CALLBACK_URL so common slips still work:
// missing path (just the site address), missing https://, http:// on a public host, trailing slash.
function buildCallbackUrl() {
  let raw = (process.env.CALLBACK_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/^["']|["']$/g, '');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!local) url.protocol = 'https:'; // Render and other hosts serve https only
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/auth/callback';
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = ''; url.hash = '';
  return url.toString();
}
const CALLBACK_URL = buildCallbackUrl();
console.log(`OAuth2 redirect URI in use: ${CALLBACK_URL}`);
console.log('If Discord says "Invalid OAuth2 redirect_uri", add EXACTLY that URL in Developer Portal > OAuth2 > Redirects and press Save.');

const MANAGE_GUILD = 0x20n;
const ADMIN = 0x8n;
// View Channel, Send Messages, Embed Links, Add Reactions, Read History, Mention Everyone, Manage Roles
const INVITE_PERMS = 1024 + 2048 + 16384 + 64 + 65536 + 131072 + 268435456;

passport.serializeUser((u, d) => d(null, { id: u.id, username: u.username, guilds: u.guilds.map((g) => ({ id: g.id, name: g.name, owner: g.owner, permissions: g.permissions })) }));
passport.deserializeUser((u, d) => d(null, u));
passport.use(new Strategy({
  clientID: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  callbackURL: CALLBACK_URL,
  scope: ['identify', 'guilds'],
}, (_a, _r, profile, done) => done(null, profile)));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, mongoOptions: { serverSelectionTimeoutMS: 15000 } }),
  cookie: { secure: 'auto', httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5 },
}));
app.use(passport.initialize());
app.use(passport.session());

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const authed = (req, res, next) => (req.isAuthenticated() ? next() : res.status(401).json({ error: 'Not logged in' }));
const canManage = (req, res, next) => {
  const g = req.user.guilds.find((x) => x.id === req.params.id);
  const p = g && BigInt(g.permissions);
  if (!g || !(g.owner || (p & MANAGE_GUILD) || (p & ADMIN))) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// ---- games: the website and the bot talk through MongoDB (the bot's host has no open web port) ----
// Reads come straight from the database. Changes are queued as a WebJob; the bot runs it within a few
// seconds (re-checking the user is an Administrator) and writes the result back, which we wait for here.
const GAMES = new Set(['countryguess', 'wordstory', 'wordchain']);
const TRIGGER_LIMITS = { min: 10, max: 200, default: 100 }; // same as the bot's Word Story limits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runJob(guildId, userId, game, action, payload) {
  const job = await WebJob.create({ guildId, userId, game, action, payload });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(700);
    const j = await WebJob.findById(job._id).lean();
    if (j && (j.status === 'done' || j.status === 'error')) {
      return j.status === 'done' ? { status: 200, data: { ok: true, message: j.message } } : { status: 400, data: { error: j.message } };
    }
  }
  await WebJob.deleteOne({ _id: job._id, status: 'pending' }); // never let it run late, after the user has given up
  return { status: 504, data: { error: "The bot didn't answer in time. Check that it is online, then try again." } };
}

const isAdminOf = (g) => !!g && (g.owner || (BigInt(g.permissions) & ADMIN) !== 0n);
const adminOnly = (req, res, next) => (isAdminOf(req.user.guilds.find((x) => x.id === req.params.id))
  ? next() : res.status(403).json({ error: 'You need the Administrator permission in that server.' }));
const jsonOnly = (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'JSON required' }));
const knownGame = (req, res, next) => (GAMES.has(req.params.game) ? next() : res.status(404).json({ error: 'Unknown game.' }));
const recent = new Map(); // user:guild:game -> last save time (stops button mashing from spamming the channel)

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/' }), (_, r) => r.redirect('/'));
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/me', authed, (req, res) => res.json({ id: req.user.id, username: req.user.username }));
app.get('/api/invite', (_req, res) => res.json({
  url: `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=${INVITE_PERMS}&scope=bot%20applications.commands`,
}));
app.get('/api/guilds', authed, wrap(async (req, res) => {
  const list = req.user.guilds
    .filter((g) => g.owner || (BigInt(g.permissions) & (MANAGE_GUILD | ADMIN)))
    .map((g) => ({ id: g.id, name: g.name, admin: isAdminOf(g), botIn: null, beta: false, features: {} }));
  if (list.length) {
    const ids = list.map((g) => g.id);
    const [here, acc] = await Promise.all([
      GuildInfo.find({ guildId: { $in: ids } }, { guildId: 1 }).lean(),
      loadAccess(ids), // beta is looked up on every load, so changes apply on the next visit
    ]);
    const inSet = new Set(here.map((x) => x.guildId));
    list.forEach((g) => {
      g.botIn = inSet.has(g.id);
      g.beta = acc.hasBeta(g.id);
      g.features = { trigger: { on: acc.can('trigger', g.id), stage: acc.stage('trigger') }, emoji: { on: acc.can('emoji', g.id), stage: acc.stage('emoji') } };
    });
  }
  res.json(list);
}));
app.get('/api/guilds/:id/feeds', authed, canManage, wrap(async (req, res) => {
  res.json(await Feed.find({ guildId: req.params.id }, { _id: 0, __v: 0 }).lean());
}));

// ---- games: Country Guess, Word Story, Word Chain (Administrator only) ----
const pick = {
  countryguess: (c) => c && { enabled: c.enabled !== false, channelId: c.channelId },
  wordstory: (c) => c && { enabled: c.enabled !== false, channelId: c.channelId, trigger: c.trigger, consecutive: c.consecutive === true, count: c.count ?? 0 },
  wordchain: (c) => c && { enabled: c.enabled !== false, channelId: c.channelId, repeatingValid: c.repeatingValid === true, consecutive: c.consecutive === true, streak: c.streak ?? 0 },
};
app.get('/api/guilds/:id/games', authed, adminOnly, wrap(async (req, res) => {
  const guildId = req.params.id;
  const info = await GuildInfo.findOne({ guildId }).lean();
  if (!info) return res.status(404).json({ error: 'not_in_guild' });
  const [cg, ws, wc] = await Promise.all([
    CountryGuessConfig.findOne({ guildId }).lean(), WordStoryConfig.findOne({ guildId }).lean(), WordChainConfig.findOne({ guildId }).lean(),
  ]);
  res.json({
    guild: { id: guildId, name: info.name },
    channels: info.channels.map((c) => ({ id: c.id, name: c.name, parent: c.parent || null })),
    limits: { trigger: TRIGGER_LIMITS },
    games: { countryguess: pick.countryguess(cg) ?? null, wordstory: pick.wordstory(ws) ?? null, wordchain: pick.wordchain(wc) ?? null },
  });
}));
app.put('/api/guilds/:id/games/:game', authed, jsonOnly, adminOnly, knownGame, wrap(async (req, res) => {
  const key = `${req.user.id}:${req.params.id}:${req.params.game}`;
  if (Date.now() - (recent.get(key) ?? 0) < 3000) return res.status(429).json({ error: 'Slow down a little.' });
  recent.set(key, Date.now());
  if (recent.size > 2000) for (const [k, t] of recent) if (Date.now() - t > 60000) recent.delete(k);
  const b = req.body || {};
  const payload = {
    channelId: typeof b.channelId === 'string' && /^\d{15,25}$/.test(b.channelId) ? b.channelId : null,
    trigger: Number.isInteger(b.trigger) ? b.trigger : null,
    consecutive: typeof b.consecutive === 'boolean' ? b.consecutive : null,
    repeatingValid: typeof b.repeatingValid === 'boolean' ? b.repeatingValid : null,
  };
  const r = await runJob(req.params.id, req.user.id, req.params.game, 'save', payload);
  res.status(r.status).json(r.data);
}));
app.post('/api/guilds/:id/games/:game/enabled', authed, jsonOnly, adminOnly, knownGame, wrap(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
  const r = await runJob(req.params.id, req.user.id, req.params.game, 'toggle', { enabled: req.body.enabled });
  res.status(r.status).json(r.data);
}));

// ---- beta access: which commands are beta, and which servers have beta access (set with !config and !betaaccess) ----
// Checked fresh on every request, so a server that gets (or loses) beta sees it on its next page load.
async function loadAccess(guildIds) {
  const [flags, betas] = await Promise.all([FeatureFlag.find().lean(), BetaGuild.find({ guildId: { $in: guildIds } }, { guildId: 1 }).lean()]);
  const beta = new Set(betas.map((b) => b.guildId));
  const stage = (name) => flags.find((f) => f.name === name)?.stage ?? (DEFAULT_BETA.has(name) ? 'beta' : 'public');
  const hasBeta = (id) => id === SERVER_ID || beta.has(id);
  return { stage, hasBeta, can: (name, id) => stage(name) === 'public' || hasBeta(id) };
}
const triggerGate = wrap(async (req, res, next) => {
  const acc = await loadAccess([req.params.id]);
  return acc.can('trigger', req.params.id) ? next() : res.status(403).json({ error: 'Triggers are not available for this server yet.' });
});

// ---- triggers (beta): custom !commands, per server, Administrator only ----
const TRIGGER_ACTIONS = [
  { value: 'role_add', label: 'Role add', needsRole: true }, { value: 'role_remove', label: 'Role remove', needsRole: true },
  { value: 'kick', label: 'Kick' }, { value: 'ban', label: 'Ban' }, { value: 'mute', label: 'Mute' },
];
app.get('/api/guilds/:id/triggers', authed, adminOnly, triggerGate, wrap(async (req, res) => {
  const guildId = req.params.id;
  const info = await GuildInfo.findOne({ guildId }).lean();
  if (!info) return res.status(404).json({ error: 'not_in_guild' });
  const rows = await TriggerConfig.find({ guildId }, { _id: 0, __v: 0 }).sort({ name: 1 }).lean();
  res.json({
    guild: { id: guildId, name: info.name },
    roles: info.roles.map((r) => ({ id: r.id, name: r.name, color: r.color, editable: r.editable })),
    actions: TRIGGER_ACTIONS, max: 20, triggers: rows,
  });
}));
app.put('/api/guilds/:id/triggers', authed, jsonOnly, adminOnly, triggerGate, wrap(async (req, res) => {
  if (Date.now() - (recent.get(`t:${req.user.id}:${req.params.id}`) ?? 0) < 2000) return res.status(429).json({ error: 'Slow down a little.' });
  recent.set(`t:${req.user.id}:${req.params.id}`, Date.now());
  const b = req.body || {};
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const payload = {
    command: str(b.command, 40), action: str(b.action, 20) || null, applyTo: b.applyTo === 'author' ? 'author' : 'target',
    roleId: typeof b.roleId === 'string' && /^\d{15,25}$/.test(b.roleId) ? b.roleId : null, duration: str(b.duration, 10) || null,
    respondType: ['reaction', 'message'].includes(b.respondType) ? b.respondType : null, respond: str(b.respond, 500),
    inReply: typeof b.inReply === 'boolean' ? b.inReply : null,
    deleteAfter: Number.isInteger(b.deleteAfter) ? b.deleteAfter : null,
    deletePrompt: typeof b.deletePrompt === 'boolean' ? b.deletePrompt : null,
    deletePromptAfter: Number.isInteger(b.deletePromptAfter) ? b.deletePromptAfter : null,
  };
  const r = await runJob(req.params.id, req.user.id, 'trigger', 'save', payload);
  res.status(r.status).json(r.data);
}));
app.delete('/api/guilds/:id/triggers/:name', authed, adminOnly, triggerGate, wrap(async (req, res) => {
  if (!/^[a-zA-Z]{1,40}$/.test(req.params.name)) return res.status(400).json({ error: 'Bad trigger name.' });
  const r = await runJob(req.params.id, req.user.id, 'trigger', 'delete', { name: req.params.name });
  res.status(r.status).json(r.data);
}));

// ---- !emoji access (beta): who can use !emoji, Administrator only ----
const emojiGate = wrap(async (req, res, next) => {
  const acc = await loadAccess([req.params.id]);
  return acc.can('emoji', req.params.id) ? next() : res.status(403).json({ error: '!emoji is not available for this server yet.' });
});
app.get('/api/guilds/:id/emoji', authed, adminOnly, emojiGate, wrap(async (req, res) => {
  const guildId = req.params.id;
  const info = await GuildInfo.findOne({ guildId }).lean();
  if (!info) return res.status(404).json({ error: 'not_in_guild' });
  const cfg = await EmojiConfig.findOne({ guildId }).lean();
  res.json({
    roles: info.roles.map((r) => ({ id: r.id, name: r.name, color: r.color })),
    config: { userIds: cfg?.userIds ?? [], roleIds: cfg?.roleIds ?? [], defaultPerm: cfg?.defaultPerm ?? true },
  });
}));
app.put('/api/guilds/:id/emoji', authed, jsonOnly, adminOnly, emojiGate, wrap(async (req, res) => {
  if (Date.now() - (recent.get(`e:${req.user.id}:${req.params.id}`) ?? 0) < 2000) return res.status(429).json({ error: 'Slow down a little.' });
  recent.set(`e:${req.user.id}:${req.params.id}`, Date.now());
  const b = req.body || {};
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && /^\d{15,25}$/.test(x)))].slice(0, 50) : []);
  const r = await runJob(req.params.id, req.user.id, 'emoji', 'save', { userIds: ids(b.userIds), roleIds: ids(b.roleIds), defaultPerm: b.defaultPerm !== false });
  res.status(r.status).json(r.data);
}));

app.use('/resource', express.static(path.join(__dirname, '../resource'), { maxAge: '1d' })); // logo: resource/bot.jpg
app.use(express.static(path.join(__dirname, '../public')));
app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message }); // expected problems (bot unreachable, not configured)
  console.error(err); res.status(500).json({ error: 'Internal error' });
});

mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('Dashboard up')))
  .catch((e) => {
    console.error(`MongoDB connection failed: ${e.message.split('\n')[0]}`);
    console.error('Check MONGODB_URI, and in Atlas > Network Access allow Render (or 0.0.0.0/0).');
    process.exit(1);
  });
