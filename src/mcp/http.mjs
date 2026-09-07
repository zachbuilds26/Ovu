#!/usr/bin/env node
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOvuServer } from './app.mjs';

/**
 * OVU as an MCP server, over Streamable HTTP.
 *
 * Same seven tools as stdio, no new logic. Stateless on purpose: one fresh
 * server per request, nothing kept in memory, so any host (Railway, Fly,
 * Render) can run it with no sticky sessions. The signal log stays on disk
 * at OVU_LOG / signals.json.
 *
 * Abuse brakes are deliberately small and dependency-free: a 1 MB body cap
 * and 60 POSTs/minute per IP. Each tool call fans out to Binance, so an
 * unthrottled public URL could get this host rate-limited upstream.
 *
 * Run:  PORT=3000 node src/mcp/http.mjs
 * Agent OS: add https://<your-host>/mcp as a custom connector.
 */

const PORT = Number(process.env.PORT ?? 3000);

/** Reject absurd bodies before they accumulate. MCP calls are small JSON. */
const MAX_BODY_BYTES = 1_000_000;

/** Per-IP sliding window. 60/min is generous for an agent, tight for a flood. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
/** @type {Map<string, number[]>} */
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const window = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  window.push(now);
  hits.set(ip, window);
  if (hits.size > 10_000) hits.clear();
  return window.length > RATE_LIMIT;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`body exceeds the ${MAX_BODY_BYTES}-byte limit`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'ovu', version: '0.1.0' }));
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found — POST to /mcp, GET /health' }));
    return;
  }

  if (req.method === 'GET') {
    // No SSE stream in stateless mode; tell the client plainly.
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'use POST /mcp for tool calls' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed — use POST /mcp' }));
    return;
  }

  const ip = req.socket.remoteAddress ?? 'unknown';
  if (rateLimited(ip)) {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '60',
    });
    res.end(JSON.stringify({ error: 'rate limited — 60 requests per minute per IP' }));
    return;
  }

  try {
    const body = await readJson(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = createOvuServer();
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`ovu http listening on :${PORT} — POST /mcp, GET /health`);
});
