const log = require("./logger");

const TAG = "PROXY";

let _dispatcher = null;
let _wsAgentInstance = null;

/**
 * Must be called early in startup (after dotenv is loaded).
 * Monkey-patches global `fetch` to route through the HTTP proxy
 * and sets HTTP_PROXY/HTTPS_PROXY env vars for axios-based libraries
 * (e.g. @polymarket/clob-client).
 */
function setupProxy() {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) {
    log.info(TAG, "No proxy configured (set PROXY_URL to enable)");
    return;
  }

  const masked = proxyUrl.replace(/:[^:@/]*@/, ":***@");
  log.info(TAG, `Routing all traffic through ${masked}`);

  // 1. Patch global fetch via undici ProxyAgent
  try {
    const { ProxyAgent, fetch: undFetch } = require("undici");
    _dispatcher = new ProxyAgent(proxyUrl);

    globalThis.fetch = (url, opts = {}) =>
      undFetch(url, { ...opts, dispatcher: _dispatcher });

    log.info(TAG, "Global fetch patched with undici ProxyAgent");
  } catch (err) {
    log.error(TAG, `Failed to patch fetch: ${err.message}`);
  }

  // 2. Set env vars for libraries that read HTTP_PROXY (axios, got, etc.)
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;
}

/**
 * Returns an https-proxy-agent instance for use with the `ws` WebSocket lib.
 * Returns undefined when no proxy is configured.
 */
function getWsAgent() {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) return undefined;

  if (!_wsAgentInstance) {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    _wsAgentInstance = new HttpsProxyAgent(proxyUrl);
  }
  return _wsAgentInstance;
}

module.exports = { setupProxy, getWsAgent };
