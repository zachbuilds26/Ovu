import https from 'node:https';
import dns from 'node:dns';

/**
 * JSON GET over HTTPS with no dependencies, and explicit DNS resolution.
 *
 * Why this isn't just `fetch`: on some machines the system resolver refuses to
 * resolve Binance hostnames (ISP-level blocking, or a VPN that doesn't cover
 * the shell), returning ENOTFOUND while public DNS answers fine. Passing a
 * custom `lookup` to https.request doesn't help — the connection agent doesn't
 * forward it — so we resolve the address ourselves and connect to it directly.
 *
 * `servername` stays set to the real hostname, so TLS certificate validation
 * still happens against the host we meant to reach, not the bare IP. This is
 * what `curl --resolve` does.
 *
 * Public DNS is tried first because it's the path known to work; the system
 * resolver is the fallback for environments that block outbound port 53.
 */

const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];
const CACHE_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, { addresses: string[], expires: number }>} */
const cache = new Map();

let resolver = null;
function publicResolver() {
  if (!resolver) {
    resolver = new dns.promises.Resolver();
    resolver.setServers(PUBLIC_DNS);
  }
  return resolver;
}

function systemResolve(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, family: 4 }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });
}

/**
 * Resolve to IPv4 addresses, cached for five minutes. These are usually
 * CloudFront and they rotate, which is why nothing here is ever hardcoded.
 * @param {string} hostname
 * @returns {Promise<string[]>}
 */
export async function resolveHost(hostname) {
  const hit = cache.get(hostname);
  if (hit && hit.expires > Date.now()) return hit.addresses;

  let addresses;
  try {
    addresses = await publicResolver().resolve4(hostname);
  } catch {
    addresses = await systemResolve(hostname);
  }

  if (!addresses || !addresses.length) throw new Error(`could not resolve ${hostname}`);
  cache.set(hostname, { addresses, expires: Date.now() + CACHE_TTL_MS });
  return addresses;
}

function requestOnce(address, host, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: address,
        port: 443,
        path,
        method: 'GET',
        servername: host,
        headers: { host, accept: 'application/json', 'user-agent': 'ovu/0.1' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;

          if (status === 429 || status === 418) {
            reject(new Error(`${host} rate limited (${status}) — back off before retrying`));
          } else if (status < 200 || status >= 300) {
            reject(new Error(`${host}${path} returned ${status}: ${body.slice(0, 300)}`));
          } else {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error(`${host}${path} returned non-JSON: ${body.slice(0, 200)}`));
            }
          }
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${host}${path} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * @param {string} host   e.g. 'fapi.binance.com'
 * @param {string} path   e.g. '/fapi/v1/premiumIndex?symbol=BTCUSDT'
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 * @returns {Promise<any>}
 */
export async function getJson(host, path, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const retries = opts.retries ?? 2;
  const addresses = await resolveHost(host);

  // Try each address before giving up — one CloudFront edge can be unreachable
  // while the others are fine.
  let lastError;
  for (const address of addresses) {
    try {
      return await requestOnce(address, host, path, timeoutMs);
    } catch (err) {
      // A real HTTP error means we reached the server; another address won't help.
      if (/returned \d{3}|rate limited|non-JSON/.test(err.message)) {
        // ...except a throttle, which sometimes clears in seconds. Back off
        // gently (shared hosting IPs get throttled for neighbours' sins) and
        // retry the same request before admitting defeat.
        if (/rate limited/.test(err.message) && retries > 0) {
          await new Promise((r) => setTimeout(r, retries === 2 ? 2000 : 5000));
          return getJson(host, path, { timeoutMs, retries: retries - 1 });
        }
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError ?? new Error(`${host}${path} unreachable`);
}
