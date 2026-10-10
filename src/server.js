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
const { Feed } = require('./models');

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

// ---- talking to the bot (game settings live in the bot, which keeps their live state) ----
const BOT_URL = (process.env.BOT_URL || '').replace(/\/+$/, '');
const GAMES = new Set(['countryguess', 'wordstory', 'wordchain']);
const botConfigured = () => !!(BOT_URL && process.env.INTERNAL_SECRET);
if (!botConfigured()) console.warn('BOT_URL / INTERNAL_SECRET not set: the website cannot configure games until you add them.');

async function callBot(method, path, userId, body, timeoutMs = 30000) {
  if (!botConfigured()) throw Object.assign(new Error('The website is not connected to the bot yet (BOT_URL and INTERNAL_SECRET are missing).'), { status: 503 });
  let res;
  try {
    res = await fetch(`${BOT_URL}/internal${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-secret': process.env.INTERNAL_SECRET, ...(userId ? { 'x-user-id': userId } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw Object.assign(new Error('The bot is unreachable right now. If it just restarted, try again in a minute.'), { status: 502 });
  }
  return { status: res.status, data: await res.json().catch(() => ({})) };
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
    .map((g) => ({ id: g.id, name: g.name, admin: isAdminOf(g), botIn: null }));
  if (botConfigured() && list.length) {
    try { // is the bot in each server? (null = couldn't ask)
      const r = await callBot('GET', `/present?ids=${list.map((g) => g.id).join(',')}`, null, null, 6000);
      if (r.status === 200) { const here = new Set(r.data.present); list.forEach((g) => { g.botIn = here.has(g.id); }); }
    } catch { /* leave botIn as null */ }
  }
  res.json(list);
}));
app.get('/api/guilds/:id/feeds', authed, canManage, wrap(async (req, res) => {
  res.json(await Feed.find({ guildId: req.params.id }, { _id: 0, __v: 0 }).lean());
}));

// ---- games: Country Guess, Word Story, Word Chain (Administrator only) ----
app.get('/api/guilds/:id/games', authed, adminOnly, wrap(async (req, res) => {
  const r = await callBot('GET', `/guilds/${req.params.id}/games`, req.user.id);
  res.status(r.status).json(r.data);
}));
app.put('/api/guilds/:id/games/:game', authed, jsonOnly, adminOnly, knownGame, wrap(async (req, res) => {
  const key = `${req.user.id}:${req.params.id}:${req.params.game}`;
  if (Date.now() - (recent.get(key) ?? 0) < 3000) return res.status(429).json({ error: 'Slow down a little.' });
  recent.set(key, Date.now());
  if (recent.size > 2000) for (const [k, t] of recent) if (Date.now() - t > 60000) recent.delete(k);
  const b = req.body || {};
  const body = {
    channelId: typeof b.channelId === 'string' && /^\d{15,25}$/.test(b.channelId) ? b.channelId : null,
    trigger: Number.isInteger(b.trigger) ? b.trigger : null,
    consecutive: typeof b.consecutive === 'boolean' ? b.consecutive : null,
    repeatingValid: typeof b.repeatingValid === 'boolean' ? b.repeatingValid : null,
  };
  const r = await callBot('PUT', `/guilds/${req.params.id}/games/${req.params.game}`, req.user.id, body);
  res.status(r.status).json(r.data);
}));
app.post('/api/guilds/:id/games/:game/enabled', authed, jsonOnly, adminOnly, knownGame, wrap(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
  const r = await callBot('POST', `/guilds/${req.params.id}/games/${req.params.game}/enabled`, req.user.id, { enabled: req.body.enabled });
  res.status(r.status).json(r.data);
}));

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
