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

const ADMIN = 0x8n;
const CDN = 'https://cdn.discordapp.com';
const avatarUrl = (u) => (u.avatar
  ? `${CDN}/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=64`
  : `${CDN}/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`);
const iconUrl = (g) => (g.icon ? `${CDN}/icons/${g.id}/${g.icon}.${g.icon.startsWith('a_') ? 'gif' : 'png'}?size=64` : null);
const slimGuild = (g) => ({ id: g.id, name: g.name, owner: g.owner, permissions: g.permissions, icon: g.icon || null });
// View Channel, Send Messages, Embed Links, Add Reactions, Read History, Mention Everyone, Manage Roles
const INVITE_PERMS = 1024 + 2048 + 16384 + 64 + 65536 + 131072 + 268435456;

// The access token stays in the server-side session (never sent to the browser); it is only used by the refresh button.
passport.serializeUser((u, d) => d(null, {
  id: u.id, username: u.username, name: u.global_name || u._json?.global_name || null, avatar: u.avatar || null,
  token: u.accessToken || null, guilds: u.guilds.map(slimGuild),
}));
passport.deserializeUser((u, d) => d(null, u));
passport.use(new Strategy({
  clientID: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  callbackURL: CALLBACK_URL,
  scope: ['identify', 'guilds'],
}, (accessToken, _r, profile, done) => { profile.accessToken = accessToken; done(null, profile); }));

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

app.get('/api/me', authed, (req, res) => res.json({ id: req.user.id, username: req.user.username, name: req.user.name || req.user.username, avatar: avatarUrl(req.user) }));
app.get('/api/invite', (_req, res) => res.json({
  url: `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=${INVITE_PERMS}&scope=bot%20applications.commands`,
}));

// Only servers where the user is an Administrator AND the bot is present.
async function listGuilds(user) {
  const list = user.guilds.filter(isAdminOf);
  if (!list.length) return [];
  const ids = list.map((g) => g.id);
  const [here, acc] = await Promise.all([
    GuildInfo.find({ guildId: { $in: ids } }, { guildId: 1 }).lean(),
    loadAccess(ids), // beta is looked up on every load, so changes apply on the next visit
  ]);
  const inSet = new Set(here.map((x) => x.guildId));
  return list.filter((g) => inSet.has(g.id)).map((g) => ({
    id: g.id, name: g.name, icon: iconUrl(g), admin: true, beta: acc.hasBeta(g.id),
    features: { trigger: { on: acc.can('trigger', g.id), stage: acc.stage('trigger') }, emoji: { on: acc.can('emoji', g.id), stage: acc.stage('emoji') } },
  }));
}
app.get('/api/guilds', authed, wrap(async (req, res) => res.json(await listGuilds(req.user))));

// Refresh button: re-reads the user's servers/permissions from Discord, then re-checks where the bot is.
app.post('/api/refresh', authed, wrap(async (req, res) => {
  const key = `r:${req.user.id}`;
  if (Date.now() - (recent.get(key) ?? 0) < 3000) return res.status(429).json({ error: 'Slow down a little.' });
  recent.set(key, Date.now());
  if (!req.user.token) return res.status(401).json({ error: 'Please log in again to refresh your servers.' });
  let r;
  try { r = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers: { authorization: `Bearer ${req.user.token}` }, signal: AbortSignal.timeout(10000) }); }
  catch { return res.status(502).json({ error: "Couldn't reach Discord. Try again in a moment." }); }
  if (r.status === 401) return res.status(401).json({ error: 'Your Discord login expired. Please log in again.' });
  if (r.status === 429) return res.status(429).json({ error: 'Discord is busy. Try again in a few seconds.' });
  if (!r.ok) return res.status(502).json({ error: 'Discord could not be reached right now.' });
  const user = { ...req.user, guilds: (await r.json()).map(slimGuild) };
  req.session.passport.user = user; req.user = user;
  await new Promise((done) => req.session.save(done));
  res.json(await listGuilds(user));
}));

// ---- feeds (Word of the Day, Daily Fact): managed straight in the shared database, Administrator only ----
const FEED_TYPES = new Set(['wotd', 'dailyfact']);
const FEED_LIMITS = { minMs: 3600000, maxMs: 30 * 864e5 }; // 1 hour .. 30 days
const FEED_DEFAULTS = { wotd: { emoji: '📖' }, dailyfact: { emoji: '💡' } };
const knownFeed = (req, res, next) => (FEED_TYPES.has(req.params.type) ? next() : res.status(404).json({ error: 'Unknown feed.' }));
app.get('/api/guilds/:id/feeds', authed, adminOnly, wrap(async (req, res) => {
  const guildId = req.params.id;
  const info = await GuildInfo.findOne({ guildId }).lean();
  if (!info) return res.status(404).json({ error: 'not_in_guild' });
  const rows = await Feed.find({ guildId }).lean();
  const feeds = { wotd: null, dailyfact: null };
  rows.forEach((f) => {
    if (FEED_TYPES.has(f.type)) feeds[f.type] = { enabled: f.enabled !== false, channelId: f.channelId, roleId: f.roleId || null, emoji: f.emoji, intervalMs: f.intervalMs, nextRunAt: f.nextRunAt, failures: f.failures || 0 };
  });
  res.json({
    channels: info.channels.map((c) => ({ id: c.id, name: c.name, parent: c.parent || null })),
    roles: info.roles.map((r) => ({ id: r.id, name: r.name, color: r.color })),
    limits: FEED_LIMITS, defaults: FEED_DEFAULTS, feeds,
  });
}));
// Create or update. Existing feeds accept partial bodies (e.g. only { enabled }); a new feed needs channelId, emoji and intervalMs.
app.put('/api/guilds/:id/feeds/:type', authed, jsonOnly, adminOnly, knownFeed, wrap(async (req, res) => {
  const { id: guildId, type } = req.params;
  const key = `f:${req.user.id}:${guildId}:${type}`;
  if (Date.now() - (recent.get(key) ?? 0) < 1000) return res.status(429).json({ error: 'Slow down a little.' });
  recent.set(key, Date.now());
  const info = await GuildInfo.findOne({ guildId }).lean();
  if (!info) return res.status(404).json({ error: 'not_in_guild' });
  const b = req.body || {};
  const cur = await Feed.findOne({ guildId, type });
  const set = {};
  if (typeof b.enabled === 'boolean') set.enabled = b.enabled;
  if (b.channelId !== undefined) {
    if (typeof b.channelId !== 'string' || !info.channels.some((c) => c.id === b.channelId)) return res.status(400).json({ error: 'Pick a channel from the list.' });
    set.channelId = b.channelId;
  }
  if (b.roleId !== undefined) {
    if (!b.roleId) set.roleId = null;
    else if (typeof b.roleId === 'string' && info.roles.some((r) => r.id === b.roleId)) set.roleId = b.roleId;
    else return res.status(400).json({ error: 'Pick a role from the list.' });
  }
  if (b.emoji !== undefined) {
    const e = typeof b.emoji === 'string' ? b.emoji.trim() : '';
    if (!e || e.length > 64) return res.status(400).json({ error: 'Add an emoji (up to 64 characters).' });
    set.emoji = e;
  }
  if (b.intervalMs !== undefined) {
    const n = b.intervalMs;
    if (!(cur && cur.intervalMs === n) && (!Number.isInteger(n) || n < FEED_LIMITS.minMs || n > FEED_LIMITS.maxMs)) return res.status(400).json({ error: 'The interval must be between 1 hour and 30 days.' });
    set.intervalMs = n;
  }
  const now = new Date();
  if (!cur) {
    if (set.enabled === false) return res.json({ ok: true, message: 'Nothing to change.' });
    for (const f of ['channelId', 'emoji', 'intervalMs']) if (set[f] === undefined) return res.status(400).json({ error: `Missing ${f}.` });
    try {
      await Feed.create({ guildId, type, channelId: set.channelId, roleId: set.roleId ?? null, emoji: set.emoji, intervalMs: set.intervalMs, nextRunAt: now, enabled: true, failures: 0, createdBy: req.user.id });
    } catch (e) { if (e.code === 11000) return res.status(409).json({ error: 'That feed already exists. Refresh the page.' }); throw e; }
    return res.json({ ok: true, message: 'Feed set up.' });
  }
  if (set.intervalMs !== undefined && set.intervalMs !== cur.intervalMs) {
    const base = cur.lastPostAt ? cur.lastPostAt.getTime() : now.getTime();
    set.nextRunAt = new Date(Math.max(base + set.intervalMs, now.getTime()));
  }
  if (set.enabled === true && cur.enabled === false && !set.nextRunAt && cur.nextRunAt < now) set.nextRunAt = now;
  if (Object.keys(set).length) set.failures = 0; // any edit clears the failure counter
  await Feed.updateOne({ guildId, type }, { $set: set });
  res.json({ ok: true, message: 'Saved.' });
}));
app.delete('/api/guilds/:id/feeds/:type', authed, adminOnly, knownFeed, wrap(async (req, res) => {
  await Feed.deleteOne({ guildId: req.params.id, type: req.params.type });
  res.json({ ok: true, message: 'Feed deleted.' });
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
    config: { enabled: cfg?.enabled ?? true, userIds: cfg?.userIds ?? [], roleIds: cfg?.roleIds ?? [], defaultPerm: cfg?.defaultPerm ?? true },
  });
}));
app.put('/api/guilds/:id/emoji', authed, jsonOnly, adminOnly, emojiGate, wrap(async (req, res) => {
  if (Date.now() - (recent.get(`e:${req.user.id}:${req.params.id}`) ?? 0) < 1000) return res.status(429).json({ error: 'Slow down a little.' });
  recent.set(`e:${req.user.id}:${req.params.id}`, Date.now());
  const b = req.body || {};
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && /^\d{15,25}$/.test(x)))].slice(0, 50) : undefined); // undefined = leave unchanged
  const r = await runJob(req.params.id, req.user.id, 'emoji', 'save', {
    userIds: ids(b.userIds), roleIds: ids(b.roleIds),
    defaultPerm: typeof b.defaultPerm === 'boolean' ? b.defaultPerm : undefined, enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
  });
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
