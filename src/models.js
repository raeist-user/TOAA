// SHARED FILE: keep identical in HeavenCloud-bot/src and Render-dashboard/src.
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

module.exports = { Feed, Used };
