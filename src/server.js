require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const mongoose = require('mongoose');
const path = require('path');
const { GuildConfig, ConfigVersion, ModCase } = require('./models');
const { parseConfig, DEFAULT_YAML } = require('./configSchema');

const MANAGE_GUILD = 0x20n;
const ADMIN = 0x8n;

passport.serializeUser((u, d) => d(null, { id: u.id, username: u.username, guilds: u.guilds.map((g) => ({ id: g.id, name: g.name, owner: g.owner, permissions: g.permissions })) }));
passport.deserializeUser((u, d) => d(null, u));
passport.use(new Strategy({
  clientID: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
  scope: ['identify', 'guilds'],
}, (_a, _r, profile, done) => done(null, profile)));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
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

async function ensureConfig(guildId) {
  let g = await GuildConfig.findOne({ guildId }).lean();
  if (!g) {
    try {
      g = (await GuildConfig.create({ guildId, yaml: DEFAULT_YAML, version: 1, updatedBy: 'system' })).toObject();
      await ConfigVersion.create({ guildId, version: 1, yaml: DEFAULT_YAML, authorName: 'system', note: 'Initial config' });
    } catch { g = await GuildConfig.findOne({ guildId }).lean(); }
  }
  return g;
}

function notifyBot(guildId) {
  if (!process.env.BOT_INTERNAL_URL) return;
  fetch(`${process.env.BOT_INTERNAL_URL}/internal/invalidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-secret': process.env.INTERNAL_SECRET },
    body: JSON.stringify({ guildId }),
  }).catch((e) => console.warn('Bot notify failed (cache expires in 5m):', e.message));
}

// Validates, bumps version (optimistic lock), records history, notifies the bot.
async function saveConfig(guildId, yaml, user, baseVersion, note) {
  const result = parseConfig(yaml);
  if (!result.ok) return { status: 400, body: { error: 'Config has errors', errors: result.errors } };
  const updated = await GuildConfig.findOneAndUpdate(
    { guildId, version: baseVersion },
    { $set: { yaml, updatedAt: new Date(), updatedBy: user.id }, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (!updated) return { status: 409, body: { error: 'Config was changed elsewhere. Reload and try again.' } };
  await ConfigVersion.create({ guildId, version: updated.version, yaml, authorId: user.id, authorName: user.username, note });
  notifyBot(guildId);
  return { status: 200, body: { version: updated.version, updatedAt: updated.updatedAt } };
}

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/' }), (_, r) => r.redirect('/'));
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/me', authed, (req, res) => res.json({ id: req.user.id, username: req.user.username }));
app.get('/api/guilds', authed, (req, res) => res.json(
  req.user.guilds
    .filter((g) => g.owner || (BigInt(g.permissions) & (MANAGE_GUILD | ADMIN)))
    .map((g) => ({ id: g.id, name: g.name })),
));

app.get('/api/guilds/:id/config', authed, canManage, wrap(async (req, res) => {
  const g = await ensureConfig(req.params.id);
  res.json({ yaml: g.yaml, version: g.version, updatedAt: g.updatedAt });
}));

app.post('/api/guilds/:id/config/validate', authed, canManage, (req, res) => {
  const r = parseConfig(req.body.yaml);
  res.json({ ok: r.ok, errors: r.errors });
});

app.post('/api/guilds/:id/config', authed, canManage, wrap(async (req, res) => {
  await ensureConfig(req.params.id);
  const { status, body } = await saveConfig(req.params.id, req.body.yaml, req.user, Number(req.body.baseVersion), 'Edited in dashboard');
  res.status(status).json(body);
}));

app.get('/api/guilds/:id/config/history', authed, canManage, wrap(async (req, res) => {
  res.json(await ConfigVersion.find({ guildId: req.params.id }, { yaml: 0 }).sort({ version: -1 }).limit(50).lean());
}));

app.get('/api/guilds/:id/config/history/:version', authed, canManage, wrap(async (req, res) => {
  const v = await ConfigVersion.findOne({ guildId: req.params.id, version: Number(req.params.version) }).lean();
  if (!v) return res.status(404).json({ error: 'Version not found' });
  res.json({ yaml: v.yaml, version: v.version });
}));

app.post('/api/guilds/:id/config/rollback', authed, canManage, wrap(async (req, res) => {
  const v = await ConfigVersion.findOne({ guildId: req.params.id, version: Number(req.body.version) }).lean();
  if (!v) return res.status(404).json({ error: 'Version not found' });
  const cur = await ensureConfig(req.params.id);
  const { status, body } = await saveConfig(req.params.id, v.yaml, req.user, cur.version, `Rollback to v${v.version}`);
  res.status(status).json(body);
}));

app.get('/api/guilds/:id/cases', authed, canManage, wrap(async (req, res) => {
  const q = { guildId: req.params.id };
  if (/^\d{15,25}$/.test(req.query.user || '')) q.userId = req.query.user;
  res.json(await ModCase.find(q).sort({ caseId: -1 }).limit(100).lean());
}));

app.use(express.static(path.join(__dirname, '../public')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });

mongoose.connect(process.env.MONGODB_URI).then(() => app.listen(process.env.PORT || 3000, () => console.log('Dashboard up')));
