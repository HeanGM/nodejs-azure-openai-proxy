// server.js
require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { URL } = require('url');
const bcrypt = require('bcryptjs');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { Pool } = require('pg');

const app = express();

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '4h';
// const WHICH_TO_USE = process.env.WHICH_TO_USE || 'azure'; // 'azure' or 'openai'
// if (process.env.NODE_ENV === 'production' && (!process.env.VALID_USER || !process.env.VALID_PASS_HASH)) {
//   throw new Error('Missing VALID_USER or VALID_PASS_HASH in production environment');
// }
// const VALID_USER = process.env.VALID_USER;
// const VALID_PASS_HASH = process.env.VALID_PASS_HASH;

// Azure OpenAI
// const AZURE_KEY = process.env.AZURE_OPENAI_KEY;
// const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
// const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-11-15-preview';

// OpenAI Direct
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ORG = process.env.OPENAI_ORG_ID; // optional.
const TOKEN_LIMIT_PER_MINUTE = parseInt(process.env.TOKEN_LIMIT_PER_MINUTE) || 2000;

// if (!AZURE_KEY || !AZURE_ENDPOINT || !AZURE_DEPLOYMENT) {
//   console.warn('Warning: AZURE_OPENAI_* environment vars missing.');
// }
if (!OPENAI_KEY) {
  console.warn('Warning: OPENAI_API_KEY missing.');
}

// React client origin
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN;
app.use(cors({ origin: CLIENT_ORIGIN ? [CLIENT_ORIGIN] : '*' }));
app.use(express.json({ limit: '50kb' }));
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
    res.header('Access-Control-Allow-Origin', '*'); // Or '*' for all origins
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

// -------------------- AUTH /login --------------------
// app.post('/login', (req, res) => {
//   const { username, password } = req.body || {};
//   if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

//   if (username !== VALID_USER)
//     return res.status(401).json({ error: 'Invalid credentials' + username + ' . ' + VALID_USER });

//   const match = bcrypt.compareSync(password, VALID_PASS_HASH);
//   if (!match)
//     return res.status(401).json({ error: 'Invalid credentials' });

//   const token = jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
//   return res.json({ token, expiresIn: JWT_EXPIRES_IN });
// });

// JWT verification middleware
function verifyJwt(req, res, next) {
  // const auth = req.get('authorization') || '';
  // const match = auth.match(/^Bearer (.+)$/);
  // if (!match) return res.status(401).json({ error: 'missing or invalid authorization header' });

  // jwt.verify(match[1], JWT_SECRET, (err, decoded) => {
  //   if (err) return res.status(401).json({ error: 'invalid token' });
  //   req.user = decoded;
  //   next();
  // });

  next();
}

// -------------------- Azure OpenAI fetch - Keeping for future --------------------
// async function azureFetch(path = 'chat/completions', body) {
//   if (!AZURE_ENDPOINT || !AZURE_KEY || !AZURE_DEPLOYMENT) throw new Error('Azure OpenAI config missing');

//   const url = new URL(`${AZURE_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${AZURE_DEPLOYMENT}/${path}`);
//   url.searchParams.set('api-version', AZURE_API_VERSION);

//   const resp = await fetch(url.toString(), {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json', 'api-key': AZURE_KEY },
//     body: JSON.stringify(body)
//   });

//   const text = await resp.text();
//   let parsed;
//   try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
//   return { status: resp.status, body: parsed };
// }

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
app.post('/chat/completions', verifyJwt, async (req, res) => {
  try {
    // ✅ NEW: check if limit reached before calling model
    const allowed = await canProceedWithRequest(100);
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
