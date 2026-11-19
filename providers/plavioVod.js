/**
 * providers/plavioVod.js
 *
 * Plavio VOD provider (movie + series, up to 4K, HTTPS only).
 * Accepts EITHER a TMDB ID (numeric) OR an IMDb ID (ttXXXXXXX).
 * Converts TMDB → IMDb automatically using ../utils/tmdbKey.
 */

'use strict';

const axios = require('axios');
const { getTmdbApiKey } = require('../utils/tmdbKey');

// ─────────────────────────────────────────────────────────────────────────────
// Config (the exact source set you supplied)
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
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const EXTRACT_CONCURRENCY = 5;
const TIMEOUT_STREAM_LIST = 20_000;
const TIMEOUT_EXTRACT     = 20_000;
const TIMEOUT_TMDB        = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// TMDB → IMDb cache + converter
// ─────────────────────────────────────────────────────────────────────────────
const imdbCache = new Map(); // `${mediaType}:${tmdbId}` → 'ttXXXXXXX'

async function tmdbToImdb(tmdbId, tmdbMediaType) {
  const key = `${tmdbMediaType}:${tmdbId}`;
  if (imdbCache.has(key)) return imdbCache.get(key);

  const apiKey = getTmdbApiKey();
  if (!apiKey) {
    console.warn('[plavioVod] TMDB API key missing — cannot convert TMDB ID to IMDb');
    return null;
  }

  const endpoint =
    tmdbMediaType === 'tv'
      ? `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`
      : `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`;

  try {
    const res = await axios.get(endpoint, {
      params: { api_key: apiKey },
      timeout: TIMEOUT_TMDB,
    });
    const imdbId = res.data?.imdb_id;
    if (imdbId && imdbId.startsWith('tt')) {
      imdbCache.set(key, imdbId);
      return imdbId;
    }
    console.warn(`[plavioVod] No IMDb ID on TMDB for ${key}`);
  } catch (err) {
    console.error(`[plavioVod] TMDB→IMDb lookup failed for ${key}: ${err.message}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const DIRECT_MEDIA_EXT = /\.(m3u8|mp4|mpd|mkv|webm|ts)(\?|$)/i;
const MEDIA_CONTENT_TYPE =
  /^(video\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)|audio\/)/i;

const isDirectMediaUrl  = (u) => !!u && DIRECT_MEDIA_EXT.test(u);
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
  const res = await axios.get(url, {
    headers: DEFAULT_HEADERS,
    timeout: TIMEOUT_STREAM_LIST,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
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
      // JSON body?
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

      // Embedded media URL in HTML?
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
// Registry calls: getStreams(tmdbId, 'movie'|'tv', season, episode)
// Direct calls:   getStreams(imdbId, 'movie'|'series', season, episode)
// ─────────────────────────────────────────────────────────────────────────────
async function getStreams(...args) {
  let rawId, type, season, episode;

  if (args.length >= 5) {
    [, rawId, type, season, episode] = args;      // (tmdbId, imdbId, type, s, e)
  } else if (args.length === 4) {
    [rawId, type, season, episode] = args;         // (id, type, s, e)
  } else {
    [rawId, type] = args;                          // (id, type)
  }

  type = type || 'movie';
  if (!rawId) return [];

  // Normalise type: 'tv' → 'series' (Plavio's URL uses /series/)
  const plavioType = type === 'tv' || type === 'series' ? 'series' : 'movie';
  const tmdbMediaType = plavioType === 'series' ? 'tv' : 'movie';

  // Resolve final IMDb ID
  const idStr = String(rawId);
  let imdbId;
  if (idStr.startsWith('tt')) {
    imdbId = idStr;
  } else {
    imdbId = await tmdbToImdb(idStr, tmdbMediaType);
    if (!imdbId) {
      console.warn(`[plavioVod] Could not resolve IMDb ID from TMDB ${idStr}`);
      return [];
    }
  }

  // Fetch Plavio stream list
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

  // Resolve in bounded batches
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
