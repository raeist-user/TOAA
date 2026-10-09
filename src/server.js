require('dotenv').config();
const missing = ['CLIENT_ID', 'CLIENT_SECRET', 'CALLBACK_URL', 'MONGODB_URI', 'SESSION_SECRET'].filter((k) => !process.env[k]);
if (missing.length) { console.error(`Missing environment variables: ${missing.join(', ')}`); process.exit(1); }

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const mongoose = require('mongoose');
const path = require('path');
const { Feed } = require('./models');

const MANAGE_GUILD = 0x20n;
const ADMIN = 0x8n;
// View Channel, Send Messages, Embed Links, Add Reactions, Read History, Mention Everyone, Manage Roles
const INVITE_PERMS = 1024 + 2048 + 16384 + 64 + 65536 + 131072 + 268435456;

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

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/callback', passport.authenticate('discord', { failureRedirect: '/' }), (_, r) => r.redirect('/'));
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/me', authed, (req, res) => res.json({ id: req.user.id, username: req.user.username }));
app.get('/api/invite', (_req, res) => res.json({
  url: `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=${INVITE_PERMS}&scope=bot%20applications.commands`,
}));
app.get('/api/guilds', authed, (req, res) => res.json(
  req.user.guilds
    .filter((g) => g.owner || (BigInt(g.permissions) & (MANAGE_GUILD | ADMIN)))
    .map((g) => ({ id: g.id, name: g.name })),
));
app.get('/api/guilds/:id/feeds', authed, canManage, wrap(async (req, res) => {
  res.json(await Feed.find({ guildId: req.params.id }, { _id: 0, __v: 0 }).lean());
}));

app.use(express.static(path.join(__dirname, '../public')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });

mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('Dashboard up')))
  .catch((e) => {
    console.error(`MongoDB connection failed: ${e.message.split('\n')[0]}`);
    console.error('Check MONGODB_URI, and in Atlas > Network Access allow Render (or 0.0.0.0/0).');
    process.exit(1);
  });
