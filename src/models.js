// SHARED FILE: keep identical in bot/src and dashboard/src.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const Feed = mongoose.models.Feed || mongoose.model('Feed', (() => {
  const s = new Schema({
    guildId: { type: String, required: true },
    type: { type: String, enum: ['wotd', 'dailyfact'], required: true },
    channelId: { type: String, required: true },
    roleId: { type: String, default: null },
    emoji: { type: String, required: true },
    intervalMs: { type: Number, required: true },
    nextRunAt: { type: Date, required: true },
    lastPostAt: Date,
    failures: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    createdBy: String,
  });
  s.index({ guildId: 1, type: 1 }, { unique: true });
  s.index({ enabled: 1, nextRunAt: 1 });
  return s;
})());

// Remembers what was already posted so words/facts don't repeat.
const Used = mongoose.models.Used || mongoose.model('Used', new Schema({
  guildId: { type: String, index: true },
  type: String,
  key: String,
  createdAt: { type: Date, default: Date.now },
}));

// Quotes: which channel quotes go to, and a record of each posted quote (for the "Remove my quote" button).
const QuoteConfig = mongoose.models.QuoteConfig || mongoose.model('QuoteConfig', new Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  respondType: { type: String, enum: ['reaction', 'message', 'none'], default: 'reaction' },
  deleteAfter: { type: Number, default: 10, min: 0, max: 60 }, // seconds, 0 = never delete the bot's response
  theme: { type: String, default: 'gray' },
}));
const Quote = mongoose.models.Quote || mongoose.model('Quote', new Schema({
  guildId: String,
  channelId: String,
  messageId: { type: String, index: true },
  userIds: [String],
  quoterId: String,
  createdAt: { type: Date, default: Date.now },
}));

// Bump reminder: one per server. remindAt is the pending countdown (null = waiting for the next DISBOARD bump).
const BumpConfig = mongoose.models.BumpConfig || mongoose.model('BumpConfig', new Schema({
  guildId: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: true },
  channelId: { type: String, default: null }, // null = the channel where the bump happened
  lastChannelId: { type: String, default: null },
  roleId: { type: String, default: null },
  message: { type: String, default: '${roleping} you can now ${bumpping}' },
  intervalMs: { type: Number, default: 2 * 3600000 },
  remindAt: { type: Date, default: null, index: true },
}));

// Error log channel: one per server.
const LogConfig = mongoose.models.LogConfig || mongoose.model('LogConfig', new Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  enabled: { type: Boolean, default: true },
}));

// Country Guess: the one channel where !countryguess can be played.
const CountryGuessConfig = mongoose.models.CountryGuessConfig || mongoose.model('CountryGuessConfig', new Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  enabled: { type: Boolean, default: true },
}));

// Word Story: the one channel where members write a story word by word. `count` is how many words the batch in progress has (the words themselves are read back from the channel).
const WordStoryConfig = mongoose.models.WordStoryConfig || mongoose.model('WordStoryConfig', new Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  trigger: { type: Number, default: 100, min: 10, max: 200 }, // words per posted story
  count: { type: Number, default: 0, min: 0 },
  consecutive: { type: Boolean, default: false }, // false = the same person can't write two words in a row
}));

// Word Chain: the one channel where members chain words (each starts with the last letter of the previous one). The running state is kept so a restart doesn't lose the streak.
const WordChainConfig = mongoose.models.WordChainConfig || mongoose.model('WordChainConfig', new Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  repeatingValid: { type: Boolean, default: false }, // false = a word already used in this chain breaks it
  consecutive: { type: Boolean, default: false }, // false (default) = the same person typing twice in a row breaks the chain; true = allowed
  streak: { type: Number, default: 0, min: 0 },
  letter: { type: String, default: null }, // the letter the next word must start with (null = any)
  words: { type: [String], default: [] }, // words used in the current chain
  lastMessageId: { type: String, default: null }, // newest correct word (the one that carries the chain reaction)
}));

// AFK: server settings, plus one row per person who is currently AFK.
const AfkConfig = mongoose.models.AfkConfig || mongoose.model('AfkConfig', new Schema({
  guildId: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: true },
  respondType: { type: String, enum: ['reaction', 'message'], default: 'reaction' },
  reaction: { type: String, default: '📵' },
  message: { type: String, default: '${username} has gone afk due to ${reason}' },
  deleteAfter: { type: Number, default: 10, min: 0, max: 60 }, // seconds, 0 = keep
  rename: { type: Boolean, default: false }, // nickname becomes "[AFK] Name" while away
}));
const afkStatusSchema = new Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  reason: { type: String, default: '' },
  until: { type: Date, default: null, index: true }, // null = until they talk again
  renamed: { type: Boolean, default: false },
  originalNick: { type: String, default: null },
  afkNick: { type: String, default: null },
}, { timestamps: true });
afkStatusSchema.index({ guildId: 1, userId: 1 }, { unique: true });
const AfkStatus = mongoose.models.AfkStatus || mongoose.model('AfkStatus', afkStatusSchema);

// Triggers: custom "!command"s built with /trigger. One row per command per server.
const TriggerConfig = mongoose.models.TriggerConfig || mongoose.model('TriggerConfig', (() => {
  const s = new Schema({
    guildId: { type: String, required: true },
    name: { type: String, required: true }, // the word after "!"
    enabled: { type: Boolean, default: true },
    action: { type: String, enum: ['role_add', 'role_remove', 'kick', 'ban', 'mute'], default: null },
    applyTo: { type: String, enum: ['author', 'target'], default: 'target' },
    roleId: { type: String, default: null },
    durationMs: { type: Number, default: null }, // mute length
    respondType: { type: String, enum: ['reaction', 'message'], default: 'reaction' },
    respond: { type: String, default: '' }, // an emoji, or message text with ${...} variables
    inReply: { type: Boolean, default: true },
    deleteAfter: { type: Number, default: 0, min: 0, max: 60 }, // seconds, 0 = keep my response
    deletePrompt: { type: Boolean, default: false },
    deletePromptAfter: { type: Number, default: 0, min: 0, max: 60 }, // seconds, 0 = right away
    createdBy: String,
  });
  s.index({ guildId: 1, name: 1 }, { unique: true });
  return s;
})());

// Servers the bot refuses to stay in (!blockserver). It leaves them as soon as it is invited.
const BlockedGuild = mongoose.models.BlockedGuild || mongoose.model('BlockedGuild', new Schema({
  guildId: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  blockedBy: String,
  blockedAt: { type: Date, default: Date.now },
}));

// Website <-> bot messaging through the shared database (the bot's host has no open web port).
// The website writes a WebJob; the bot picks it up within a few seconds, runs it, and writes the result back.
const WebJob = mongoose.models.WebJob || mongoose.model('WebJob', (() => {
  const s = new Schema({
    guildId: { type: String, required: true },
    userId: { type: String, required: true }, // the logged-in website user; the bot re-checks they are an Administrator
    game: { type: String, enum: ['countryguess', 'wordstory', 'wordchain', 'trigger', 'emoji'], required: true },
    action: { type: String, enum: ['save', 'toggle', 'delete'], required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['pending', 'running', 'done', 'error'], default: 'pending' },
    message: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, expires: 3600 }, // old jobs clean themselves up
  });
  s.index({ status: 1, createdAt: 1 });
  return s;
})());

// What the bot publishes for the website: which servers it is in, and their text channels.
const GuildInfo = mongoose.models.GuildInfo || mongoose.model('GuildInfo', new Schema({
  guildId: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  channels: { type: [{ _id: false, id: String, name: String, parent: String }], default: [] },
  roles: { type: [{ _id: false, id: String, name: String, color: String, editable: Boolean }], default: [] }, // for the website's trigger form
  updatedAt: { type: Date, default: Date.now },
}));

// Who can use !emoji in a server (set with /emoji or on the website). Manage Expressions is the default permission.
const EmojiConfig = mongoose.models.EmojiConfig || mongoose.model('EmojiConfig', new Schema({
  guildId: { type: String, required: true, unique: true },
  userIds: { type: [String], default: [] },
  roleIds: { type: [String], default: [] },
  defaultPerm: { type: Boolean, default: true }, // true: members with Manage Expressions can use it too
}));

// Beta system: which commands are beta (!config) and which servers have beta access (!betaaccess).
const FeatureFlag = mongoose.models.FeatureFlag || mongoose.model('FeatureFlag', new Schema({
  name: { type: String, required: true, unique: true },
  stage: { type: String, enum: ['beta', 'public'], required: true },
}));
const BetaGuild = mongoose.models.BetaGuild || mongoose.model('BetaGuild', new Schema({
  guildId: { type: String, required: true, unique: true },
  addedAt: { type: Date, default: Date.now },
}));

module.exports = { EmojiConfig, FeatureFlag, BetaGuild, WebJob, GuildInfo, BlockedGuild, Feed, Used, QuoteConfig, Quote, BumpConfig, LogConfig, AfkConfig, AfkStatus, CountryGuessConfig, WordStoryConfig, WordChainConfig, TriggerConfig };
