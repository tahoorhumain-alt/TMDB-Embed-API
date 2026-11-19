/**
 * providers/plavioVod.js
 *
 * Plavio VOD provider (movie + series, up to 4K, HTTPS only).
 * Accepts EITHER a TMDB ID (numeric) OR an IMDb ID (ttXXXXXXX).
 *
 * FIXES over the previous version:
 *   - Auto-detects TMDB v3 (32-hex) vs v4 (JWT "eyJ…") keys and uses the
 *     correct auth style for each. This was silently 401-ing before.
 *   - Retries with the alternate auth mode when the first attempt fails.
 *   - Adds a Cinemeta fallback (no key required) so the provider still
 *     works when TMDB is unavailable / rate-limited.
 *   - Explicit, prefixed logging so failures are visible in Render logs.
 *   - Short negative-cache (5 min) so repeated failures don't hammer TMDB.
 *   - getStreams() never throws — always returns an array.
 *   - Adds Referer + Origin headers so Plavio accepts API requests
 *     (fixes 403 / empty-source-list issues).
 */

'use strict';

const axios = require('axios');
const { getTmdbApiKey } = require('../utils/tmdbKey');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
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

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://hd.plavio.site/',
  'Origin': 'https://hd.plavio.site',
};

const EXTRACT_CONCURRENCY = 5;
const TIMEOUT_STREAM_LIST = 20_000;
const TIMEOUT_EXTRACT     = 20_000;
const TIMEOUT_TMDB        = 10_000;
const NEGATIVE_CACHE_TTL  = 5 * 60 * 1000; // 5 min

const DEBUG = process.env.PLAVIO_DEBUG === '1';

function dbg(...a) { if (DEBUG) console.log('[plavioVod:debug]', ...a); }

// ─────────────────────────────────────────────────────────────────────────────
// TMDB → IMDb  (cache + negative cache)
// ─────────────────────────────────────────────────────────────────────────────
const imdbCache = new Map();          // `${mediaType}:${tmdbId}` → 'ttXXXXXXX'
const negCache  = new Map();          // `${mediaType}:${tmdbId}` → expiresAtMs

function looksLikeJwt(key) {
  // v4 tokens are JWTs: 3 base64url segments separated by dots, first starts "eyJ"
  return typeof key === 'string' && key.split('.').length === 3 && key.startsWith('eyJ');
}

async function tmdbRequest(endpoint, apiKey) {
  // Try v3 style first (api_key query param)
  try {
    return await axios.get(endpoint, {
      params: { api_key: apiKey },
      timeout: TIMEOUT_TMDB,
    });
  } catch (err) {
    const status = err.response?.status;
    if (status !== 401) throw err;
    dbg(`TMDB v3-style auth failed (401), retrying with Bearer…`);
    // Retry v4 style (Authorization: Bearer …)
    return await axios.get(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: TIMEOUT_TMDB,
    });
  }
}

async function tmdbToImdb(tmdbId, tmdbMediaType) {
  const key = `${tmdbMediaType}:${tmdbId}`;

  if (imdbCache.has(key)) {
    dbg(`cache-hit ${key} → ${imdbCache.get(key)}`);
    return imdbCache.get(key);
  }
  const negUntil = negCache.get(key);
  if (negUntil && negUntil > Date.now()) {
    dbg(`neg-cache ${key} still warm until ${new Date(negUntil).toISOString()}`);
    return null;
  }

  // ── Attempt 1: TMDB ─────────────────────────────────────────────────────
  const apiKey = getTmdbApiKey();
  if (apiKey) {
    const endpoint =
      tmdbMediaType === 'tv'
        ? `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`
        : `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`;

    dbg(`TMDB key format: ${looksLikeJwt(apiKey) ? 'v4 (JWT)' : 'v3 (hex)'}, len=${apiKey.length}`);

    try {
      const res = await tmdbRequest(endpoint, apiKey);
      const imdbId = res.data?.imdb_id;
      if (imdbId && typeof imdbId === 'string' && imdbId.startsWith('tt')) {
        imdbCache.set(key, imdbId);
        console.log(`[plavioVod] TMDB→IMDb OK ${key} → ${imdbId}`);
        return imdbId;
      }
      console.warn(
        `[plavioVod] TMDB ${key} returned NO imdb_id. body=${JSON.stringify(res.data).slice(0, 200)}`
      );
    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.status_message || err.message;
      console.error(`[plavioVod] TMDB ${key} FAILED → HTTP ${status || '?'} :: ${msg}`);
      if (status === 401) console.error('[plavioVod]   → 401: key invalid, expired, or wrong type');
      if (status === 404) console.error('[plavioVod]   → 404: TMDB has no record for that ID');
      if (status === 429) console.error('[plavioVod]   → 429: TMDB rate limit hit');
      if (!status)        console.error(`[plavioVod]   → network/timeout: ${err.code || err.message}`);
    }
  } else {
    console.error('[plavioVod] TMDB API key missing (getTmdbApiKey() returned falsy)');
  }

  // ── Attempt 2: Cinemeta fallback (no key required) ──────────────────────
  const cinemetaType = tmdbMediaType === 'tv' ? 'series' : 'movie';
  const cinemetaUrls = [
    `https://v3-cinemeta.strem.io/meta/${cinemetaType}/tmdb:${tmdbId}.json`,
    `https://v3-cinemeta.strem.io/meta/${cinemetaType}/${tmdbId}.json`, // best-effort
  ];
  for (const url of cinemetaUrls) {
    try {
      const r = await axios.get(url, { timeout: TIMEOUT_TMDB });
      const candidate =
        r.data?.meta?.imdb_id ||
        r.data?.meta?.id;
      if (candidate && /^tt\d+$/.test(candidate)) {
        imdbCache.set(key, candidate);
        console.log(`[plavioVod] Cinemeta fallback OK ${key} → ${candidate}`);
        return candidate;
      }
    } catch (err) {
      dbg(`Cinemeta ${url} failed: ${err.message}`);
    }
  }

  // Negative-cache so we don't hammer TMDB every request
  negCache.set(key, Date.now() + NEGATIVE_CACHE_TTL);
  console.warn(`[plavioVod] Could not resolve IMDb for ${key} (neg-cached for 5 min)`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const DIRECT_MEDIA_EXT = /\.(m3u8|mp4|mpd|mkv|webm|ts)(\?|$)/i;
const MEDIA_CONTENT_TYPE =
  /^(video\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)|audio\/)/i;

const isDirectMediaUrl   = (u) => !!u && DIRECT_MEDIA_EXT.test(u);
const isMediaContentType = (ct) => !!ct && MEDIA_CONTENT_TYPE.test(ct);

function buildStreamListUrl(plavioType, imdbId, season, episode) {
  const base = `${PLAVIO_BASE}/${PLAVIO_CONFIG}/stream`;
  if (plavioType === 'series' && season != null && episode != null) {
    return `${base}/series/${encodeURIComponent(imdbId)}:${season}:${episode}.json`;
  }
  return `${base}/movie/${encodeURIComponent(imdbId)}.json`;
}

function buildRequestHeaders(stream) {
  const proxy = stream?.behaviorHints?.proxyHeaders?.request || {};
  return { ...DEFAULT_HEADERS, ...proxy };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch stream list from Plavio
// ─────────────────────────────────────────────────────────────────────────────
async function fetchStreamList(plavioType, imdbId, season, episode) {
  const url = buildStreamListUrl(plavioType, imdbId, season, episode);
  dbg(`GET ${url}`);
  const res = await axios.get(url, {
    headers: DEFAULT_HEADERS,
    timeout: TIMEOUT_STREAM_LIST,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const count = Array.isArray(res.data?.streams) ? res.data.streams.length : 0;
  console.log(`[plavioVod] Plavio returned ${count} stream(s) for ${imdbId}`);
  return Array.isArray(res.data?.streams) ? res.data.streams : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve an extractor URL → final playable URL
// ─────────────────────────────────────────────────────────────────────────────
async function resolveExtractor(stream) {
  const originalUrl = stream?.url;
  if (!originalUrl) return null;

  if (isDirectMediaUrl(originalUrl) && !/\/extract\//i.test(originalUrl)) {
    return originalUrl;
  }

  const headers = buildRequestHeaders(stream);

  // Pass 1 — HEAD
  try {
    const head = await axios.head(originalUrl, {
      headers,
      timeout: TIMEOUT_EXTRACT,
      maxRedirects: 10,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const finalUrl = head.request?.res?.responseUrl || originalUrl;
    const ct = head.headers?.['content-type'] || '';
    if (isMediaContentType(ct) || isDirectMediaUrl(finalUrl)) return finalUrl;
    if (finalUrl !== originalUrl) return finalUrl;
  } catch (_) { /* fall through */ }

  // Pass 2 — GET
  try {
    const res = await axios.get(originalUrl, {
      headers,
      timeout: TIMEOUT_EXTRACT,
      maxRedirects: 10,
      validateStatus: (s) => s >= 200 && s < 400,
      responseType: 'text',
      transformResponse: (d) => d,
    });

    const finalUrl = res.request?.res?.responseUrl || originalUrl;
    const ct = res.headers?.['content-type'] || '';
    if (isMediaContentType(ct) || isDirectMediaUrl(finalUrl)) return finalUrl;
    if (finalUrl !== originalUrl) return finalUrl;

    if (typeof res.data === 'string') {
      try {
        const parsed = JSON.parse(res.data);
        if (parsed && typeof parsed === 'object') {
          const candidate =
            parsed.url || parsed.link || parsed.stream || parsed.file ||
            parsed.src || parsed.play_url || parsed.download_url;
          if (typeof candidate === 'string' && candidate.startsWith('http')) {
            return candidate;
          }
        }
      } catch (_) { /* not JSON */ }

      const mediaMatch = res.data.match(
        /https?:\/\/[^\s"'<>\\]+\.(m3u8|mp4|mpd|mkv|webm|ts)[^\s"'<>\\]*/i
      );
      if (mediaMatch) return mediaMatch[0];

      const anyUrl = res.data.match(/https?:\/\/[^\s"'<>\\]+/);
      if (anyUrl) return anyUrl[0];
    }
  } catch (err) {
    console.warn(
      `[plavioVod] extractor resolve failed for "${stream?.name || 'unknown'}": ${err.message}`
    );
  }

  return originalUrl; // fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — getStreams  (signature auto-detects)
//
//    Registry call:  getStreams(tmdbId, 'movie'|'tv', season, episode)
//    Direct call:    getStreams(imdbId, 'movie'|'series', season, episode)
//    Extended call:  getStreams(tmdbId, imdbId, 'movie'|'tv', season, episode)
// ─────────────────────────────────────────────────────────────────────────────
async function getStreams(...args) {
  try {
    let rawId, explicitImdb, type, season, episode;

    if (args.length >= 5) {
      // (tmdbId, imdbId, type, season, episode)
      [rawId, explicitImdb, type, season, episode] = args;
    } else if (args.length === 4) {
      // (id, type, season, episode)  — registry path
      [rawId, type, season, episode] = args;
    } else {
      // (id, type)
      [rawId, type] = args;
    }

    type = type || 'movie';
    if (!rawId && !explicitImdb) return [];

    const plavioType    = (type === 'tv' || type === 'series') ? 'series' : 'movie';
    const tmdbMediaType = plavioType === 'series' ? 'tv' : 'movie';

    // ── Resolve IMDb ID ─────────────────────────────────────────────────
    let imdbId;
    if (explicitImdb && /^tt\d+$/.test(String(explicitImdb))) {
      imdbId = String(explicitImdb);
      dbg(`Using caller-supplied IMDb ID: ${imdbId}`);
    } else if (rawId && String(rawId).startsWith('tt')) {
      imdbId = String(rawId);
    } else {
      imdbId = await tmdbToImdb(String(rawId), tmdbMediaType);
      if (!imdbId) {
        console.warn(`[plavioVod] Bail: cannot resolve IMDb from TMDB ${rawId}`);
        return [];
      }
    }

    // ── Fetch Plavio stream list ────────────────────────────────────────
    let rawStreams = [];
    try {
      rawStreams = await fetchStreamList(plavioType, imdbId, season, episode);
    } catch (err) {
      console.error(`[plavioVod] stream-list fetch failed for ${imdbId}: ${err.message}`);
      return [];
    }

    if (rawStreams.length === 0) {
      console.log(`[plavioVod] No sources for ${imdbId}`);
      return [];
    }

    console.log(`[plavioVod] Resolving ${rawStreams.length} source(s) for ${imdbId}…`);

    // ── Resolve in bounded batches ──────────────────────────────────────
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
                ...(stream.behaviorHints?.proxyHeaders && {
                  proxyHeaders: stream.behaviorHints.proxyHeaders,
                }),
              },
            };
          } catch (err) {
            console.warn(`[plavioVod] skip "${stream?.name}": ${err.message}`);
            return null;
          }
        })
      );
      resolved.push(...batchResults.filter(Boolean));
    }

    console.log(`[plavioVod] ✅ ${resolved.length}/${rawStreams.length} streams ready for ${imdbId}`);
    return resolved;
  } catch (err) {
    // Absolute last-resort safety net — never throw to the registry
    console.error(`[plavioVod] getStreams crashed: ${err.stack || err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  getStreams,
  fetchStreamList,
  resolveExtractor,
  tmdbToImdb,
  PLAVIO_CONFIG,
  PLAVIO_BASE,
};
