// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { Pool } = require('pg');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 3000;

// OpenAI Direct
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ORG = process.env.OPENAI_ORG_ID; // optional.
const TOKEN_LIMIT_PER_MINUTE = parseInt(process.env.TOKEN_LIMIT_PER_MINUTE) || 2000;

if (!OPENAI_KEY) {
  console.warn('Warning: OPENAI_API_KEY missing.');
}

// Session settings
const SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL_SECONDS || '60') * 60; // default 60 min
const SESSION_LIMIT = parseInt(process.env.SESSION_LIMIT || '150'); // active sessions cap

// Redis
const REDIS_URL = process.env.REDIS_URL; // e.g. redis://:pass@host:port
if (!REDIS_URL) console.warn('Warning: REDIS_URL is not set.');
const redis = createClient({ url: REDIS_URL, socket: { tls: true, rejectUnauthorized:false } });
redis.on('error', (err) => console.error('Redis error', err));

// React client origin
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN;
// app.use(cors({ origin: CLIENT_ORIGIN ? [CLIENT_ORIGIN] : '*' }));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100kb' }));
app.set('trust proxy', true);

// -------------------- POSTGRES CONNECTION --------------------
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS token_usage (
      minute TIMESTAMP PRIMARY KEY,
      total_tokens INTEGER NOT NULL
    );
  `);
  }
  catch (err) {
    console.error('Postgres connection error:', err.message);
    process.exit(1);
  }
})();

// Table schema (run in your DB once):
// CREATE TABLE IF NOT EXISTS usage_stats (
//   id SERIAL PRIMARY KEY,
//   timestamp TIMESTAMPTZ DEFAULT NOW(),
//   tokens INTEGER NOT NULL
// );

// Redis keys
const SESSIONS_SET = 'sessions:active'; // Set of active session IDs
const SESSIONS_Z = 'sessions:z';        // ZSET of session IDs scored by expiry timestamp (ms)
const SESSION_KEY = (id) => `session:${id}`; // volatile key with TTL

async function initRedis() {
  try {
    if (!redis.isOpen) {
      await redis.connect();
      console.log('✅ Redis connected');
    }
  } catch (err) {
    console.error('Redis connection failed:', err.message);
    process.exit(1); // optional: fail hard if Redis is required
  }
}

// Connect at startup
(async () => {
  await initRedis();
})();

process.on('SIGTERM', async () => {
  console.log('Shutting down, closing Redis connection...');
  if (redis.isOpen) await redis.quit();
  process.exit(0);
});

// Remove expired sessions (based on ZSET); keep SESSIONS_SET clean.
async function purgeExpiredSessions() {
  const now = Date.now();
  // Pop expired ids from ZSET
  const expiredIds = await redis.zRangeByScore(SESSIONS_Z, 0, now);
  if (expiredIds.length > 0) {
    const pipeline = redis.multi();
    pipeline.zRem(SESSIONS_Z, expiredIds);
    pipeline.sRem(SESSIONS_SET, expiredIds);
    expiredIds.forEach((id) => pipeline.del(SESSION_KEY(id))); // in case still there
    await pipeline.exec();
  }
}

async function getActiveCount() {
  // Ensure we remove expired first, then count
  await purgeExpiredSessions();
  return await redis.sCard(SESSIONS_SET);
}

async function createSession() {
  await purgeExpiredSessions();
  const active = await redis.sCard(SESSIONS_SET);
  if (active >= SESSION_LIMIT) {
    return { ok: false, reason: 'capacity' };
  }

  const id = uuidv4();
  const expiresAtMs = Date.now() + SESSION_TTL_SECONDS * 1000;

  const pipeline = redis.multi();
  pipeline.sAdd(SESSIONS_SET, id);
  pipeline.zAdd(SESSIONS_Z, [{ score: expiresAtMs, value: id }]);
  pipeline.set(SESSION_KEY(id), '1', { EX: SESSION_TTL_SECONDS }); // TTL auto-expire
  await pipeline.exec();

  return { ok: true, id, expiresAt: new Date(expiresAtMs).toISOString() };
}

async function touchSession(sessionId) {
  // optional: refresh TTL on activity (comment out if you want fixed duration)
  if (!sessionId) return;
  const exists = await redis.exists(SESSION_KEY(sessionId));
  if (exists) {
    await redis.expire(SESSION_KEY(sessionId), SESSION_TTL_SECONDS);
    const newExp = Date.now() + SESSION_TTL_SECONDS * 1000;
    await redis.zAdd(SESSIONS_Z, [{ score: newExp, value: sessionId }]);
  }
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  const pipeline = redis.multi();
  pipeline.sRem(SESSIONS_SET, sessionId);
  pipeline.zRem(SESSIONS_Z, sessionId);
  pipeline.del(SESSION_KEY(sessionId));
  await pipeline.exec();
}

// -------------------- MIDDLEWARE --------------------
// app.use(async (req, res, next) => {
//   if (process.env.NODE_ENV === 'production') {
//     const proto = req.get('x-forwarded-proto') || req.protocol;
//     if (proto !== 'https') {
//       const host = req.get('host');
//       const originalUrl = req.originalUrl || '/';
//       return res.redirect(301, `https://${host}${originalUrl}`);
//     }
//   }
//   next();
// });

// Health + basic stats
app.get('/health', async (req, res) => {
  try {
    const count = await getActiveCount();
    res.json({ ok: true, activeSessions: count, limit: SESSION_LIMIT });
  } catch {
    res.json({ ok: true });
  }
});

// Require a valid session for model calls
async function requireSession(req, res, next) {
  const sessionId = req.get('x-session-id');
  if (!sessionId) return res.status(401).json({ error: 'Missing x-session-id' });

  const exists = await redis.exists(SESSION_KEY(sessionId));
  if (!exists) return res.status(401).json({ error: 'Invalid or expired session' });

  // touch (optional) to keep it alive while user is active
  await touchSession(sessionId);

  req.sessionId = sessionId;
  next();
}

// -------------------- SESSION ROUTES --------------------
app.post('/sessions', async (req, res) => {
  try {
    const result = await createSession();
    console.log('debugger');
    if (!result.ok && result.reason === 'capacity') {
      const count = await getActiveCount();
      return res.status(409).json({ error: 'No capacity available', active: count, limit: SESSION_LIMIT });
    }
    return res.status(201).json({ sessionId: result.id, expiresAt: result.expiresAt, ttlSeconds: SESSION_TTL_SECONDS });
  }
  catch (err) {
    console.error('Create session error:', err.message);
    return res.status(500).json({ error: err });
  }
});

// Delete session (logout)
app.delete('/sessions/:id', async (req, res) => {
  const sessionId = req.params.id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session id' });
  try {
    await deleteSession(sessionId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Delete session error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

async function updateTokenUsage(totalTokens) {
  const minute = new Date();
  minute.setSeconds(0, 0); // round to minute

  try {
    await pool.query(`
      INSERT INTO token_usage (minute, total_tokens)
      VALUES ($1, $2)
      ON CONFLICT (minute)
      DO UPDATE SET total_tokens = GREATEST(token_usage.total_tokens, EXCLUDED.total_tokens);
    `, [minute, totalTokens]);
  } catch (err) {
    console.error('Token usage update failed:', err.message);
  }
}

// -------------------- NEW: CHECK TOKEN LIMIT --------------------
async function canProceedWithRequest(limit = TOKEN_LIMIT_PER_MINUTE) {
  const minute = new Date();
  minute.setSeconds(0, 0); // round to current minute

  try {
    const { rows } = await pool.query(
      `SELECT total_tokens FROM token_usage WHERE minute = $1 LIMIT 1;`,
      [minute]
    );
    if (rows.length === 0) return true; // new minute, allow
    const current = parseInt(rows[0].total_tokens) || 0;
    return current < limit;
  } catch (err) {
    console.error('Error checking token limit:', err.message);
    // Fail open — don’t block traffic due to DB issues
    return false;
  }
}

// -------------------- MIDDLEWARE --------------------

// HTTPS enforcement
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    const proto = req.get('x-forwarded-proto') || req.protocol;
    if (proto !== 'https') {
      const host = req.get('host');
      const originalUrl = req.originalUrl || '/';
      return res.redirect(301, `https://${host}${originalUrl}`);
    }
  }
  next();
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));


// -------------------- OpenAI fetch --------------------
async function openAIFetch(path = 'chat/completions', body) {
  if (!OPENAI_KEY) throw new Error('OpenAI API key missing');

  const url = `https://api.openai.com/v1/${path}`;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` };
  if (OPENAI_ORG) headers['OpenAI-Organization'] = OPENAI_ORG;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  // Log usage to Postgres
  if (parsed.usage && parsed.usage.total_tokens) updateTokenUsage(parsed.usage.total_tokens);
  return { status: resp.status, body: parsed };
}

// -------------------- Proxy endpoint --------------------
app.post('/chat/completions', requireSession, async (req, res) => {
  try {
    // ✅ NEW: check if limit reached before calling model
    const allowed = await canProceedWithRequest();
    if (!allowed) {
      return res.status(429).json({ error: 'Token limit reached. Please wait a minute and try again. Allowed Tokens per Min: ' + TOKEN_LIMIT_PER_MINUTE });
    }

    const payload = req.body || {};
    // switch between Azure or OpenAI depending on what you want
    // const fetcher = WHICH_TO_USE === 'azure' ? azureFetch : openAIFetch;
    const fetcher = openAIFetch;
    const { status, body } = await fetcher('chat/completions', payload);
    res.status(status).json(body);
  } catch (err) {
    console.error('[chat/completions]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
