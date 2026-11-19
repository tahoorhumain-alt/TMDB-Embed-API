'use strict';

const fetch = require('node-fetch');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const ffmpegPath = require('ffmpeg-static');

// ---------- SSRF guard ----------
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[::1\]|::1$|0\.0\.0\.0)/i;
function isBlockedHost(hostname){
  if (!hostname) return true;
  if (PRIVATE_HOST_RE.test(hostname)) return true;
  // Block bare Render internal hostnames if you know them, e.g.:
  if (/\.internal$/.test(hostname)) return true;
  return false;
}
function assertSafeUrl(raw){
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) allowed');
  if (isBlockedHost(u.hostname)) throw new Error('Blocked host');
  return u;
}

// ---------- Timeouts ----------
function withTimeout(ms){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

// ---------- HLS URI rewrite ----------
function rewriteHls(content, baseUrl, referer){
  const proxify = (abs) =>
    `/proxy?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer || '')}`;

  return content.split('\n').map((line) => {
    const trimmed = line.trim();

    // Rewrite URI="..." attributes in any #EXT- tag
    if (trimmed.startsWith('#') && /URI="/.test(trimmed)) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = /^https?:/.test(uri) ? uri : new URL(uri, baseUrl).href;
        return `URI="${proxify(abs)}"`;
      });
    }

    // Pass-through comments / blank
    if (trimmed === '' || trimmed.startsWith('#')) return line;

    // Plain segment / child playlist
    const abs = /^https?:/.test(trimmed) ? trimmed : new URL(trimmed, baseUrl).href;
    return proxify(abs);
  }).join('\n');
}

function createProxyRoutes(app) {
  app.get('/proxy', async (req, res) => {
    const referer = String(req.query.referer || '');
    let targetUrl = String(req.query.url || '');

    if (!targetUrl) return res.status(400).send('Missing url parameter');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    // Unwrap hbplay base64 BEFORE validation
    if (targetUrl.includes('hbplay.pages.dev')) {
      try {
        const u = new URL(targetUrl);
        const p = u.searchParams.get('u');
        if (p) targetUrl = Buffer.from(p, 'base64').toString('utf-8');
      } catch (e) {
        console.error('[proxy] base64 unwrap failed', e.message);
      }
    }

    // Validate (SSRF guard)
    let parsed;
    try {
      parsed = assertSafeUrl(targetUrl);
    } catch (e) {
      return res.status(400).send('Rejected: ' + e.message);
    }
    targetUrl = parsed.href;

    const isHls = /\.m3u8(\?|$)/i.test(targetUrl);
    const isMkv = /\.mkv(\?|$)/i.test(targetUrl);

    const fetchOptions = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(referer ? { 'Referer': referer } : {}),
      },
      redirect: 'follow',
    };

    // ---------- A. HLS ----------
    if (isHls) {
      const to = withTimeout(20_000);
      try {
        const response = await fetch(targetUrl, { ...fetchOptions, signal: to.signal });
        if (!response.ok) return res.status(response.status).send('HLS Upstream error');

        const content = await response.text();
        const baseUrl = parsed.origin + parsed.pathname.substring(0, parsed.pathname.lastIndexOf('/') + 1);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(rewriteHls(content, baseUrl, referer));
      } catch (err) {
        console.error('[proxy][hls]', err.message);
        if (!res.headersSent) res.status(502).send('HLS Proxy failed');
      } finally {
        to.clear();
      }
      return;
    }

    // ---------- B. MKV -> MP4 (audio transcode) ----------
    if (isMkv) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'no-store');

      const args = [];
      if (referer) args.push('-headers', `Referer: ${referer}\r\n`);
      args.push(
        '-i', targetUrl,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1'
      );

      let ffmpeg;
      try {
        ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        console.error('[proxy][ffmpeg] spawn failed', err.message);
        return res.status(500).send('FFmpeg spawn failed');
      }

      // Drain stderr so ffmpeg doesn't stall
      let stderrBuf = '';
      ffmpeg.stderr.on('data', (d) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
      });

      ffmpeg.stdout.pipe(res);

      const killFfmpeg = () => { try { ffmpeg.kill('SIGKILL'); } catch {} };
      req.on('close', killFfmpeg);

      ffmpeg.on('error', (err) => {
        console.error('[proxy][ffmpeg]', err.message);
        if (!res.headersSent) res.status(500).send('FFmpeg failed');
        else try { res.end(); } catch {}
      });
      ffmpeg.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error('[proxy][ffmpeg] exited', code, stderrBuf.slice(-500));
        }
        try { res.end(); } catch {}
      });
      return;
    }

    // ---------- C. Binary passthrough (MP4, WebM, TS, …) ----------
    const to = withTimeout(60_000);
    try {
      if (req.headers.range) {
        fetchOptions.headers['Range'] = req.headers.range;
      }
      const response = await fetch(targetUrl, { ...fetchOptions, signal: to.signal });

      if (!response.ok && response.status !== 206) {
        return res.status(response.status).send('Upstream error');
      }

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
      const cl = response.headers.get('content-length');
      const cr = response.headers.get('content-range');
      if (cl) res.setHeader('Content-Length', cl);
      if (cr) { res.setHeader('Content-Range', cr); res.status(206); }

      // node-fetch v3 → Web stream; node-fetch v2 → Node stream
      if (response.body && typeof response.body.pipe === 'function') {
        response.body.pipe(res);
      } else if (response.body && typeof response.body.getReader === 'function') {
        Readable.fromWeb(response.body).pipe(res);
      } else {
        const buf = await response.buffer();
        res.send(buf);
      }
    } catch (err) {
      console.error('[proxy][binary]', err.message);
      if (!res.headersSent) res.status(502).send('Proxy request failed');
    } finally {
      to.clear();
    }
  });
}

function processStreamsForProxy(streams, serverUrl){
  if (!Array.isArray(streams)) return streams;
  return streams.map((s) => {
    if (!s || !s.url || typeof s.url !== 'string') return s;
    if (s.url.includes('vidsrc') || s.url.includes('vidrift') || s.url.includes('embed') || s.isEmbed) {
      return s;
    }
    const referer = s.behaviorHints?.proxyHeaders?.request?.Referer || '';
    return {
      ...s,
      url: `${serverUrl}/proxy?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(referer)}`,
    };
  });
}

module.exports = { createProxyRoutes, processStreamsForProxy };
