/**
 * providers/plavioVod.js
 *
 * Plavio VOD provider for TMDB-Embed-API.
 *
 * Uses the exact source configuration from:
 * https://hd.plavio.site/{CONFIG}/manifest.json
 *
 * Flow:
 *   1. Fetch stream list from  {base}/{config}/stream/{type}/{imdbId}.json
 *   2. For each stream, resolve the extractor URL to a direct media URL
 *      (handles redirects, JSON bodies, HTML embeds, and direct-proxy endpoints)
 *   3. Return Stremio-compatible stream objects to the client
 */

'use strict';

const axios = require('axios');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The exact URL-encoded source configuration you supplied (minus /manifest.json) */
const PLAVIO_CONFIG =
  '%7B%22source_4KHDHub%22%3A%22on%22%2C%22source_Cinejoy%22%3A%22on%22%2C' +
  '%22source_Cinezo%22%3A%22on%22%2C%22source_Dexter%22%3A%22on%22%2C' +
  '%22source_Mapple%22%3A%22on%22%2C%22source_MovieBox%22%3A%22on%22%2C' +
  '%22source_Movies4u%22%3A%22on%22%2C%22source_MoviesBazar%22%3A%22on%22%2C' +
  '%22source_MoviesHunt%22%3A%22on%22%2C%22source_MultiMovies%22%3A%22on%22%2C' +
  '%22source_NetMirror%22%3A%22on%22%2C%22source_Nxsha%22%3A%22on%22%2C' +
  '%22source_SoraStream%22%3A%22on%22%2C%22source_SpaceDom%22%3A%22on%22%2C' +
  '%22source_VidFast%22%3A%22on%22%2C%22source_Vidrock%22%3A%22on%22%2C' +
  '%22source_CineVood%22%3A%22on%22%2C%22source_HDHub4u%22%3A%22on%22%2C' +
  '%22source_KmMovies%22%3A%22on%22%2C%22source_MoviesDrive%22%3A%22on%22%2C' +
  '%22source_VegaMovies%22%3A%22on%22%2C%22multi%22%3A%22on%22%2C' +
  '%22en%22%3A%22on%22%7D';

const PLAVIO_BASE = 'https://hd.plavio.site';

/** Base headers used when talking to the Plavio endpoints */
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** How many extractor requests to fire concurrently */
const EXTRACT_CONCURRENCY = 5;

/** Timeouts (ms) */
const TIMEOUT_STREAM_LIST = 20_000;
const TIMEOUT_EXTRACT = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const DIRECT_MEDIA_EXT = /\.(m3u8|mp4|mpd|mkv|webm|ts)(\?|$)/i;
const MEDIA_CONTENT_TYPE = /^(video\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)|audio\/)/i;

function isDirectMediaUrl(u) {
  return !!u && DIRECT_MEDIA_EXT.test(u);
}

function isMediaContentType(ct) {
  return !!ct && MEDIA_CONTENT_TYPE.test(ct);
}

/** Build the Plavio stream-list URL for a given type/id */
function buildStreamListUrl(type, imdbId, season, episode) {
  const base = `${PLAVIO_BASE}/${PLAVIO_CONFIG}/stream`;
  if (type === 'series' && season != null && episode != null) {
    return `${base}/series/${encodeURIComponent(imdbId)}:${season}:${episode}.json`;
  }
  return `${base}/movie/${encodeURIComponent(imdbId)}.json`;
}

/** Merge default headers with any headers supplied by Plavio in behaviorHints */
function buildRequestHeaders(stream) {
  const proxy = stream?.behaviorHints?.proxyHeaders?.request || {};
  return { ...DEFAULT_HEADERS, ...proxy };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Fetch the stream list from Plavio
// ─────────────────────────────────────────────────────────────────────────────

async function fetchStreamList(type, imdbId, season, episode) {
  const url = buildStreamListUrl(type, imdbId, season, episode);
  const res = await axios.get(url, {
    headers: DEFAULT_HEADERS,
    timeout: TIMEOUT_STREAM_LIST,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return Array.isArray(res.data?.streams) ? res.data.streams : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Resolve an extractor URL to a final playable URL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plavio stream entries come in two flavours:
 *   a) Direct media URLs (`.m3u8`, `.mp4`, etc.) → return as-is
 *   b) Extractor URLs `…/extract/?index=…&url=…` → need one round-trip
 *
 * For (b) we attempt, in order:
 *   1. HEAD request → check redirect target / content-type
 *   2. GET request  → check redirect target / content-type
 *   3. Parse JSON body for url/link/stream/file keys
 *   4. Regex the body for a media URL
 *   5. Fallback → return the extractor URL itself
 */
async function resolveExtractor(stream) {
  const originalUrl = stream?.url;
  if (!originalUrl) return null;

  // Fast path: already a direct media URL (and not a Plavio extractor)
  if (isDirectMediaUrl(originalUrl) && !/\/extract\//i.test(originalUrl)) {
    return originalUrl;
  }

  const headers = buildRequestHeaders(stream);

  // ── Pass 1: HEAD (cheap, tells us redirect target & content-type) ────────
  try {
    const head = await axios.head(originalUrl, {
      headers,
      timeout: TIMEOUT_EXTRACT,
      maxRedirects: 10,
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const finalUrl = head.request?.res?.responseUrl || originalUrl;
    const ct = head.headers?.['content-type'] || '';

    if (isMediaContentType(ct) || isDirectMediaUrl(finalUrl)) {
      return finalUrl;
    }
    if (finalUrl !== originalUrl) {
      return finalUrl;
    }
  } catch (_) {
    /* HEAD often blocked — fall through to GET */
  }

  // ── Pass 2: GET (full body) ─────────────────────────────────────────────
  try {
    const res = await axios.get(originalUrl, {
      headers,
      timeout: TIMEOUT_EXTRACT,
      maxRedirects: 10,
      validateStatus: (s) => s >= 200 && s < 400,
      responseType: 'text',
      transformResponse: (d) => d, // keep raw body so we can regex it
    });

    const finalUrl = res.request?.res?.responseUrl || originalUrl;
    const ct = res.headers?.['content-type'] || '';

    if (isMediaContentType(ct) || isDirectMediaUrl(finalUrl)) {
      return finalUrl;
    }
    if (finalUrl !== originalUrl) {
      return finalUrl;
    }

    // Body may be JSON
    if (typeof res.data === 'string') {
      try {
        const parsed = JSON.parse(res.data);
        if (parsed && typeof parsed === 'object') {
          const candidate =
            parsed.url ||
            parsed.link ||
            parsed.stream ||
            parsed.file ||
            parsed.src ||
            parsed.play_url ||
            parsed.download_url;
          if (typeof candidate === 'string' && candidate.startsWith('http')) {
            return candidate;
          }
        }
      } catch (_) {
        /* not JSON, keep going */
      }

      // Body may be HTML with an embedded media URL
      const mediaMatch = res.data.match(
        /https?:\/\/[^\s"'<>\\]+\.(m3u8|mp4|mpd|mkv|webm|ts)[^\s"'<>\\]*/i
      );
      if (mediaMatch) return mediaMatch[0];

      // Last resort: any absolute URL in the body
      const anyUrl = res.data.match(/https?:\/\/[^\s"'<>\\]+/);
      if (anyUrl) return anyUrl[0];
    }
  } catch (err) {
    console.warn(
      `[plavioVod] extractor resolve failed for "${stream?.name || 'unknown'}": ${err.message}`
    );
  }

  // Fallback: return extractor URL — Stremio can still try with the proxy headers
  return originalUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Public API — getStreams
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported call signatures (auto-detected):
 *
 *   getStreams(imdbId, 'movie', null, null)
 *   getStreams(imdbId, 'series', season, episode)
 *   getStreams(tmdbId, imdbId, 'movie', null, null)
 *   getStreams(tmdbId, imdbId, 'series', season, episode)
 *
 * NOTE: Plavio requires an IMDb ID (`tt…`). If you only have a TMDB ID,
 * convert it before calling this function.
 *
 * @returns {Promise<Array>} Stremio stream objects
 */
async function getStreams(...args) {
  let imdbId, type, season, episode;

  if (args.length >= 5) {
    // (tmdbId, imdbId, type, season, episode)
    [, imdbId, type, season, episode] = args;
  } else if (args.length === 4) {
    // (imdbId, type, season, episode)
    [imdbId, type, season, episode] = args;
  } else {
    [imdbId, type] = args;
  }

  type = type || 'movie';

  if (!imdbId || typeof imdbId !== 'string') {
    console.warn('[plavioVod] No IMDb ID supplied');
    return [];
  }
  if (!imdbId.startsWith('tt')) {
    console.warn(`[plavioVod] ID "${imdbId}" is not an IMDb ID — Plavio needs ttXXXXXXX`);
    return [];
  }

  let rawStreams = [];
  try {
    rawStreams = await fetchStreamList(type, imdbId, season, episode);
  } catch (err) {
    console.error(`[plavioVod] stream-list fetch failed for ${imdbId}: ${err.message}`);
    return [];
  }

  if (rawStreams.length === 0) {
    console.log(`[plavioVod] No sources for ${imdbId}`);
    return [];
  }

  console.log(`[plavioVod] Resolving ${rawStreams.length} source(s) for ${imdbId}…`);

  // Resolve with bounded concurrency
  const resolved = [];
  for (let i = 0; i < rawStreams.length; i += EXTRACT_CONCURRENCY) {
    const batch = rawStreams.slice(i, i + EXTRACT_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (stream) => {
        try {
          const finalUrl = await resolveExtractor(stream);
          if (!finalUrl) return null;

          return {
            name: `Plavio | ${stream.name || 'Source'}`,
            title: stream.title || stream.name || 'Plavio',
            url: finalUrl,
            behaviorHints: {
              notWebReady: stream.behaviorHints?.notWebReady ?? false,
              filename: stream.behaviorHints?.filename,
              // Keep proxy headers so the client can still apply them if needed
              ...(stream.behaviorHints?.proxyHeaders && {
                proxyHeaders: stream.behaviorHints.proxyHeaders,
              }),
            },
          };
        } catch (err) {
          console.warn(
            `[plavioVod] skipping "${stream?.name || 'unknown'}": ${err.message}`
          );
          return null;
        }
      })
    );
    resolved.push(...batchResults.filter(Boolean));
  }

  console.log(
    `[plavioVod] ✅ ${resolved.length}/${rawStreams.length} streams ready for ${imdbId}`
  );
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  /** Main provider entry-point used by the API */
  getStreams,

  /** Optional helpers — useful for diagnostics / health checks */
  fetchStreamList,
  resolveExtractor,

  /** Constants (exported so other modules can reuse / override) */
  PLAVIO_CONFIG,
  PLAVIO_BASE,
};
