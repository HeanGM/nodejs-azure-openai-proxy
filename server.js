// server.js
require('dotenv').config(); // optional; safe to keep
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { URL } = require('url');
const bcrypt = require('bcrypt');

const app = express();

// Basic config via env (with sensible defaults)
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m'; // short lived by default
const BASIC_USER = process.env.BASIC_USER;
const BASIC_PASS = process.env.BASIC_PASS;

// Azure OpenAI configs (from env)
const AZURE_KEY = process.env.AZURE_OPENAI_KEY;
const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT; // e.g. https://my-resource.openai.azure.com
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT; // deployment name
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2023-11-15-preview';

if (!AZURE_KEY || !AZURE_ENDPOINT || !AZURE_DEPLOYMENT) {
  console.warn('Warning: AZURE_OPENAI_* environment vars missing. Proxy endpoints will fail until set.');
}

// allow requests from your React client origin - set it in env if you want
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN; // for production change to exact origin

// minimal middlewares
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());
app.set('trust proxy', true); // important on Heroku so we can check x-forwarded-proto

// HTTPS enforcement middleware (works on Heroku)
app.use((req, res, next) => {
  // If incoming request is not over HTTPS and the host is not localhost, redirect
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

// Simple health check
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- AUTH: /login issues JWT ----------
app.post('/login', async (req, res) => {
  // Very small/simple authentication for speed: username/password from env
  // Replace with real auth (DB, OAuth) in production
  const { username, password } = req.body || {};
  if (username !== BASIC_USER) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const match = await bcrypt.compare(password, HASHED_PASS);
  if (!match) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  return res.json({ token, expiresIn: JWT_EXPIRES_IN });
});

// JWT verification middleware
function verifyJwt(req, res, next) {
  const auth = req.get('authorization') || '';
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: 'missing or invalid authorization header' });

  const token = match[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'invalid token' });
    req.user = decoded;
    next();
  });
}

// ---------- Proxy helpers ----------
async function azureFetch(path = "chat/completions", body) {
  if (!AZURE_ENDPOINT || !AZURE_KEY || !AZURE_DEPLOYMENT) {
    throw new Error('Azure OpenAI configuration missing');
  }

  // Build url for deployment-specific route (Azure uses /openai/deployments/{deployment}/... )
  // Example path: 'chat/completions' or 'completions' or 'embeddings'
  // Full url: {AZURE_ENDPOINT}/openai/deployments/{AZURE_DEPLOYMENT}/{path}?api-version={AZURE_API_VERSION}

  const url = new URL(`${AZURE_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${AZURE_DEPLOYMENT}/${path}`);
  url.searchParams.set('api-version', AZURE_API_VERSION);

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': AZURE_KEY
    },
    body: JSON.stringify(body)
  });

  // pass through status and json
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
  return { status: resp.status, body: parsed };
}

// ---------- PROXIED ENDPOINTS (protected by JWT) ----------

// 1) Chat completions (Azure Chat Completions)
app.post('/api/azure/chat', verifyJwt, async (req, res) => {
  try {
    const payload = req.body || {};
    const { status, body } = await azureFetch('chat/completions', payload);
    res.status(status).json(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2) Standard completions
app.post('/api/azure/completions', verifyJwt, async (req, res) => {
  try {
    const payload = req.body || {};
    const { status, body } = await azureFetch('completions', payload);
    res.status(status).json(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3) Embeddings
app.post('/api/azure/embeddings', verifyJwt, async (req, res) => {
  try {
    const payload = req.body || {};
    const { status, body } = await azureFetch('embeddings', payload);
    res.status(status).json(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Minimal server start
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});