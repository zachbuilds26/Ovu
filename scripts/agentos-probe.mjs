import https from 'node:https';
import { resolveHost } from '../src/data/http.mjs';

/**
 * Probes the Agent OS OAuth surface and reports exactly what it requires.
 * Run: node scripts/agentos-probe.mjs
 *
 * This exists because the connection details that matter — which client_id form
 * the authorization server accepts, whether dynamic registration is available —
 * are not in the documentation. Better to ask the server than to guess.
 */

const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'http://localhost:8976/callback';
const RESOURCE = 'https://agent.binance.com/mcp/agentic';

/** Raw request that reports status, headers and body without judging any of them. */
async function probe(method, url, { body, headers = {} } = {}) {
  const target = new URL(url);
  const [address] = await resolveHost(target.hostname);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: address,
        port: 443,
        path: target.pathname + target.search,
        method,
        servername: target.hostname,
        headers: { host: target.hostname, accept: '*/*', 'user-agent': 'ovu/0.1', ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const show = (label, r, chars = 400) => {
  console.log(`\n--- ${label} → ${r.status}`);
  const interesting = ['www-authenticate', 'location', 'content-type'];
  for (const h of interesting) if (r.headers[h]) console.log(`    ${h}: ${r.headers[h]}`);
  if (r.body.trim()) console.log(`    ${r.body.replace(/\s+/g, ' ').slice(0, chars)}`);
};

console.log('Agent OS OAuth probe');

show('POST /mcp/agentic (no token)', await probe('POST', RESOURCE, {
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'ovu', version: '0.1.0' },
    },
  }),
}));

show('GET authorization server metadata',
  await probe('GET', 'https://agent.binance.com/.well-known/oauth-authorization-server'));

show('POST /register (dynamic registration)',
  await probe('POST', 'https://agent.binance.com/register', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'ovu', redirect_uris: [REDIRECT] }),
  }));

const authorizeUrl = (clientId) => {
  const u = new URL('https://accounts.binance.com/agentic-oauth/authorize');
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'probe',
    resource: RESOURCE,
  }).toString();
  return u.toString();
};

for (const clientId of [
  'https://example.com/ovu-client.json',
  'codex',
  'grok',
  'claude-code',
  'ovu',
]) {
  show(`GET authorize, client_id=${clientId}`, await probe('GET', authorizeUrl(clientId)), 300);
}
