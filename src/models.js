const mongoose = require('mongoose');
const { Schema } = mongoose;

const GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', new Schema({
  guildId: { type: String, unique: true, index: true },
  yaml: { type: String, required: true },
  version: { type: Number, default: 1 },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String,
}));

const ConfigVersion = mongoose.models.ConfigVersion || mongoose.model('ConfigVersion', new Schema({
  guildId: { type: String, index: true },
  version: Number,
  yaml: String,
  authorId: String,
  authorName: String,
  note: String,
  createdAt: { type: Date, default: Date.now },
}));

const Counter = mongoose.models.Counter || mongoose.model('Counter', new Schema({
  _id: String, seq: { type: Number, default: 0 },
}));

const ModCase = mongoose.models.ModCase || mongoose.model('ModCase', new Schema({
  guildId: { type: String, index: true },
  caseId: Number,
  type: String, // ban | kick | timeout | warn | automod
  userId: { type: String, index: true },
  modId: String,
  reason: { type: String, default: 'No reason provided' },
  createdAt: { type: Date, default: Date.now },
}));

async function nextCaseId(guildId) {
  const c = await Counter.findByIdAndUpdate(guildId, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return c.seq;
}

module.exports = { GuildConfig, ConfigVersion, ModCase, nextCaseId };
