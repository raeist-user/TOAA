// SHARED FILE: keep identical in bot/src and dashboard/src.
const { z } = require('zod');
const { parseDocument, LineCounter } = require('yaml');

const Snowflake = z.string().regex(/^\d{15,25}$/, 'Must be a Discord ID (wrap it in quotes)');
const Level = z.number().int().min(0).max(100000);
const LEVEL_EXPR = /^(>=|<=|>|<|=)?\s*(\d+)$/;

const ids = z.preprocess((v) => (v === undefined || Array.isArray(v) ? v : [v]), z.array(Snowflake).optional());
const levelExpr = z.preprocess(
  (v) => (typeof v === 'number' ? `=${v}` : v),
  z.string().regex(LEVEL_EXPR, 'Use a quoted expression like ">=50", "<10" or "=100"').optional(),
);

function flatten(issue) {
  if (issue.code === 'unrecognized_keys') {
    return { path: [...issue.path, issue.keys[0]], message: `Unknown key "${issue.keys.join('", "')}"` };
  }
  return { path: issue.path, message: issue.message };
}

// ---------------- automod ----------------
const triggerSchemas = {
  match_words: z.object({
    words: z.array(z.string().min(1).max(100)).min(1).max(500),
    case_sensitive: z.boolean().default(false),
    whole_word: z.boolean().default(false),
  }).strict(),
  match_regex: z.object({
    patterns: z.array(z.string().min(1).max(200)).min(1).max(50),
    case_sensitive: z.boolean().default(false),
  }).strict().superRefine((v, ctx) => {
    v.patterns.forEach((p, i) => {
      try { new RegExp(p); } catch (e) { ctx.addIssue({ code: 'custom', path: ['patterns', i], message: `Invalid regex: ${e.message}` }); }
    });
  }),
  invites: z.object({ allow_guild_ids: z.array(Snowflake).default([]) }).strict(),
  links: z.object({
    allow_domains: z.array(z.string().min(1)).default([]),
    block_domains: z.array(z.string().min(1)).default([]),
  }).strict(),
  spam: z.object({
    max_messages: z.number().int().min(2).max(50).default(5),
    seconds: z.number().min(1).max(120).default(5),
  }).strict(),
  mentions: z.object({ max: z.number().int().min(1).max(100).default(5) }).strict(),
  caps: z.object({
    min_length: z.number().int().min(5).max(2000).default(15),
    percent: z.number().min(10).max(100).default(70),
  }).strict(),
};

const Trigger = z.record(z.any()).superRefine((val, ctx) => {
  const keys = Object.keys(val);
  const valid = Object.keys(triggerSchemas).join(', ');
  if (keys.length !== 1) return ctx.addIssue({ code: 'custom', message: `Each trigger needs exactly one type (${valid})` });
  const k = keys[0];
  const s = triggerSchemas[k];
  if (!s) return ctx.addIssue({ code: 'custom', path: [k], message: `Unknown trigger "${k}". Valid: ${valid}` });
  const r = s.safeParse(val[k] ?? {});
  if (!r.success) {
    r.error.issues.forEach((is) => {
      const f = flatten(is);
      ctx.addIssue({ code: 'custom', path: [k, ...f.path], message: f.message });
    });
  }
}).transform((val) => {
  const k = Object.keys(val)[0];
  return { type: k, params: triggerSchemas[k].parse(val[k] ?? {}) };
});

const Actions = z.object({
  clean: z.boolean().default(false),
  reply: z.string().max(1000).optional(),
  warn: z.boolean().default(false),
  timeout: z.number().int().min(1).max(40320).optional(), // minutes
  kick: z.boolean().default(false),
  ban: z.boolean().default(false),
}).strict().default({});

const RuleName = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Rule names: letters, numbers, _ and - only');
const Rule = z.object({
  enabled: z.boolean().default(true),
  reason: z.string().max(200).optional(),
  triggers: z.array(Trigger).min(1, 'A rule needs at least one trigger'),
  actions: Actions,
}).strict();

const AutomodConfig = z.object({
  exempt_level: Level.nullable().default(50),
  rules: z.record(RuleName, Rule).default({}),
}).strict();

// ---------------- moderation ----------------
const ModerationConfig = z.object({
  log_channel: Snowflake.optional(),
  commands: z.object({
    ban: Level.default(50), kick: Level.default(50), timeout: Level.default(50),
    warn: Level.default(50), case: Level.default(50), cases: Level.default(50),
  }).strict().default({}),
}).strict();

const pluginSchemas = { moderation: ModerationConfig, automod: AutomodConfig };

// ---------------- root ----------------
const Override = z.object({
  channel: ids, role: ids, user: ids,
  level: levelExpr,
  config: z.record(z.any()),
}).strict();

const PluginEntry = z.object({
  enabled: z.boolean().default(true),
  config: z.record(z.any()).default({}),
  overrides: z.array(Override).default([]),
}).strict();

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (BAD_KEYS.has(k)) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

const Root = z.object({
  levels: z.record(Snowflake, Level).default({}),
  plugins: z.record(PluginEntry).default({}),
}).strict().superRefine((val, ctx) => {
  for (const [name, entry] of Object.entries(val.plugins)) {
    const schema = pluginSchemas[name];
    if (!schema) {
      ctx.addIssue({ code: 'custom', path: ['plugins', name], message: `Unknown plugin "${name}". Available: ${Object.keys(pluginSchemas).join(', ')}` });
      continue;
    }
    const base = schema.safeParse(entry.config);
    if (!base.success) {
      base.error.issues.forEach((is) => { const f = flatten(is); ctx.addIssue({ code: 'custom', path: ['plugins', name, 'config', ...f.path], message: f.message }); });
      continue;
    }
    entry.overrides.forEach((ov, i) => {
      const r = schema.safeParse(deepMerge(entry.config, ov.config));
      if (!r.success) {
        r.error.issues.forEach((is) => { const f = flatten(is); ctx.addIssue({ code: 'custom', path: ['plugins', name, 'overrides', i, 'config', ...f.path], message: f.message }); });
      }
    });
  }
}).transform((val) => {
  const plugins = { ...val.plugins };
  for (const n of Object.keys(pluginSchemas)) plugins[n] ??= { enabled: true, config: {}, overrides: [] };
  return { levels: val.levels, plugins };
});

// ---------------- parsing ----------------
function normalize(v, key) {
  if (typeof v === 'bigint') {
    return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : String(v);
  }
  if (v === null) return key === 'exempt_level' ? null : undefined;
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!BAD_KEYS.has(k)) o[k] = normalize(x, k);
    return o;
  }
  return v;
}

function locate(doc, lc, path) {
  const p = [...path];
  for (;;) {
    let node;
    try { node = p.length ? doc.getIn(p, true) : doc.contents; } catch { node = undefined; }
    if (node && node.range) return lc.linePos(node.range[0]);
    if (!p.length) return { line: 1, col: 1 };
    p.pop();
  }
}

/** @returns {{ok:boolean, data?:object, errors:{message:string,line:number,col:number}[]}} */
function parseConfig(text) {
  if (typeof text !== 'string') return { ok: false, errors: [{ message: 'Config must be text', line: 1, col: 1 }] };
  if (text.length > 100000) return { ok: false, errors: [{ message: 'Config is too large (100KB max)', line: 1, col: 1 }] };

  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, intAsBigInt: true, uniqueKeys: true });
  if (doc.errors.length) {
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const p = e.linePos?.[0];
        return { message: e.message.split('\n')[0], line: p?.line || 1, col: p?.col || 1 };
      }),
    };
  }
  const res = Root.safeParse(normalize(doc.toJS()) ?? {});
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map((is) => {
        const f = flatten(is);
        const pos = locate(doc, lc, f.path);
        const where = f.path.length ? `${f.path.join('.')}: ` : '';
        return { message: where + f.message, line: pos.line, col: pos.col };
      }),
    };
  }
  return { ok: true, data: res.data, errors: [] };
}

// ---------------- runtime resolution ----------------
function matchesLevel(expr, level) {
  const m = LEVEL_EXPR.exec(expr);
  if (!m) return false;
  const n = Number(m[2]);
  switch (m[1] || '=') {
    case '>=': return level >= n;
    case '<=': return level <= n;
    case '>': return level > n;
    case '<': return level < n;
    default: return level === n;
  }
}

function overrideMatches(ov, ctx) {
  if (ov.channel && !ov.channel.some((id) => ctx.channelIds?.includes(id))) return false;
  if (ov.role && !ov.role.some((id) => ctx.roleIds?.includes(id))) return false;
  if (ov.user && !ov.user.includes(ctx.userId)) return false;
  if (ov.level && !matchesLevel(ov.level, ctx.level ?? 0)) return false;
  return true;
}

/** Returns the fully-defaulted plugin config with matching overrides applied, or null if disabled. */
function resolvePlugin(data, name, ctx = {}) {
  const entry = data.plugins[name];
  if (!entry || !entry.enabled) return null;
  const matched = [];
  entry.overrides.forEach((ov, i) => { if (overrideMatches(ov, ctx)) matched.push(i); });
  const key = matched.join(',');
  if (!entry._cache) Object.defineProperty(entry, '_cache', { value: new Map(), enumerable: false });
  if (!entry._cache.has(key)) {
    let raw = entry.config;
    for (const i of matched) raw = deepMerge(raw, entry.overrides[i].config);
    entry._cache.set(key, pluginSchemas[name].parse(raw));
  }
  return entry._cache.get(key);
}

const DEFAULT_YAML = `# ModBot configuration (YAML)
# Tip: always wrap Discord IDs in quotes, e.g. "123456789012345678"

# Permission levels: map a ROLE ID or USER ID to a number.
# The server owner always has the highest level.
levels:
  # "123456789012345678": 100   # admin role
  # "234567890123456789": 50    # moderator role

plugins:
  moderation:
    enabled: true
    config:
      # log_channel: "123456789012345678"
      commands:          # minimum level needed to use each command
        ban: 50
        kick: 50
        timeout: 50
        warn: 50
        case: 50
        cases: 50

  automod:
    enabled: true
    config:
      exempt_level: 50   # members at/above this level skip automod (null = nobody exempt)
      rules:
        no_invites:
          enabled: true
          triggers:
            - invites: {}              # optionally: { allow_guild_ids: ["..."] }
          actions:
            clean: true
            reply: "Invites aren't allowed here."
        spam:
          enabled: true
          triggers:
            - spam: { max_messages: 5, seconds: 5 }
          actions:
            clean: true
            timeout: 10                # minutes
        mass_mentions:
          enabled: true
          triggers:
            - mentions: { max: 5 }
          actions:
            clean: true
            timeout: 30
        # Other triggers: match_words, match_regex, links, caps
        # Other actions:  warn, kick, ban, reason (rule-level text)
    # Overrides change the config for matching channel / role / user / level:
    # overrides:
    #   - channel: ["123456789012345678"]   # channel or category IDs
    #     level: ">=10"                     # optional, quoted
    #     config:
    #       rules:
    #         no_invites: { enabled: false }
`;

module.exports = { parseConfig, resolvePlugin, deepMerge, DEFAULT_YAML, pluginSchemas };
