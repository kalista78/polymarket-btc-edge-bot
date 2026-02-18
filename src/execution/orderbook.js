const config = require("../config");
const log = require("../utils/logger");

const TAG = "BOOK";

/**
 * Fetch the orderbook for a given token from the CLOB API.
 *
 * @param {string} tokenId - The CLOB token ID
 * @returns {{ bestBid, bestBidSize, bestAsk, bestAskSize, bids, asks } | null}
 */
async function fetchOrderbook(tokenId) {
  try {
    const url = `${config.clobBaseUrl}/book?token_id=${tokenId}`;
    const res = await fetch(url);

    if (!res.ok) {
      log.warn(TAG, `CLOB book returned ${res.status} for ${tokenId.slice(0, 12)}...`);
      return null;
    }

    const book = await res.json();

    // Parse bids and asks
    const bids = (book.bids || [])
      .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .sort((a, b) => b.price - a.price); // highest first

    const asks = (book.asks || [])
      .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .sort((a, b) => a.price - b.price); // lowest first

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestBidSize = bids.length > 0 ? bids[0].size : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const bestAskSize = asks.length > 0 ? asks[0].size : 0;

    return { bestBid, bestBidSize, bestAsk, bestAskSize, bids, asks };
  } catch (err) {
    log.error(TAG, `Orderbook fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Fetch orderbooks for both Up and Down tokens.
 *
 * @param {string} upTokenId
 * @param {string} downTokenId
 * @returns {{ up: orderbook, down: orderbook } | null}
 */
async function fetchBothBooks(upTokenId, downTokenId) {
  const [up, down] = await Promise.all([
    fetchOrderbook(upTokenId),
    fetchOrderbook(downTokenId),
  ]);

  if (!up && !down) return null;

  return { up, down };
}

module.exports = { fetchOrderbook, fetchBothBooks };
