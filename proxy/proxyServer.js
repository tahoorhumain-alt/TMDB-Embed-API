const express = require('express');
const fetch = require('node-fetch');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static'); // 👈 Uses the static binary from package.json
const app = express();

// Enable CORS for all requests
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

// ---------------------------------------------------------
// UNIVERSAL PROXY ROUTE
// Handles: HLS (.m3u8), MKV (with FFmpeg audio fix), MP4/other binary
// ---------------------------------------------------------
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    const referer = req.query.referer || '';

    if (!targetUrl) return res.status(400).send('Missing url parameter');

    // 1. Unwrap hbplay.pages.dev base64 URLs if present
    if (targetUrl.includes('hbplay.pages.dev')) {
        try {
            const urlObj = new URL(targetUrl);
            const uParam = urlObj.searchParams.get('u');
            if (uParam) {
                targetUrl = Buffer.from(uParam, 'base64').toString('utf-8');
            }
        } catch (e) {
            console.error('Base64 unwrap failed', e);
        }
    }

    const isHls = targetUrl.includes('.m3u8');
    const isMkv = targetUrl.toLowerCase().includes('.mkv');

    const fetchOptions = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ...(referer ? { 'Referer': referer } : {})
        }
    };

    // ---------------------------------------------------------
    // A. HLS (.m3u8) PLAYLIST REWRITER
    // ---------------------------------------------------------
    if (isHls) {
        try {
            const response = await fetch(targetUrl, fetchOptions);
            if (!response.ok) return res.status(response.status).send('HLS Upstream error');

            let content = await response.text();
            const urlObj = new URL(targetUrl);
            const baseUrl = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

            // Rewrite every segment URL to route back through this proxy
            const lines = content.split('\n');
            const rewrittenLines = lines.map(line => {
                const trimmed = line.trim();
                // Ignore empty lines and tags
                if (trimmed === '' || trimmed.startsWith('#')) {
                    return line; 
                }
                
                // Resolve relative URLs to absolute
                let absoluteUrl = trimmed;
                if (!trimmed.startsWith('http')) {
                    absoluteUrl = new URL(trimmed, baseUrl).href;
                }
                
                // Route the segment back through our proxy
                return `/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.send(rewrittenLines.join('\n'));
        } catch (err) {
            console.error('HLS Proxy Error:', err);
            res.status(500).send('HLS Proxy failed');
        }
        return;
    }

    // ---------------------------------------------------------
    // B. MKV AUDIO TRANSCODER (Using ffmpeg-static)
    // ---------------------------------------------------------
    if (isMkv) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // Spawn the static ffmpeg binary
        const ffmpeg = spawn(ffmpegPath, [
            '-headers', `Referer: ${referer}\r\n`, // Pass referer to upstream
            '-i', targetUrl,
            '-c:v', 'copy',          // Copy video track (no quality loss, fast)
            '-c:a', 'aac',           // Convert audio to AAC (Fixes muted audio)
            '-b:a', '192k',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            'pipe:1'
        ]);

        ffmpeg.stdout.pipe(res);

        ffmpeg.stderr.on('data', (data) => {
            // Uncomment for debugging:
            // console.log(`ffmpeg: ${data}`);
        });

        req.on('close', () => {
            ffmpeg.kill('SIGKILL');
        });

        ffmpeg.on('error', (err) => {
            console.error('FFmpeg Error:', err);
            if (!res.headersSent) res.status(500).send('FFmpeg execution failed');
        });
        
        return;
    }

    // ---------------------------------------------------------
    // C. BINARY STREAMING (MP4, WebM, etc.)
    // ---------------------------------------------------------
    try {
        // Pass the Range header if the browser requests it (for seeking)
        if (req.headers.range) {
            fetchOptions.headers['Range'] = req.headers.range;
        }

        const response = await fetch(targetUrl, fetchOptions);
        
        if (!response.ok && response.status !== 206) {
            return res.status(response.status).send('Upstream error');
        }

        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (response.headers.get('content-length')) {
            res.setHeader('Content-Length', response.headers.get('content-length'));
        }
        if (response.headers.get('content-range')) {
            res.setHeader('Content-Range', response.headers.get('content-range'));
            res.status(206);
        }

        // Stream the body directly to the client
        response.body.pipe(res);

    } catch (err) {
        console.error('Binary Proxy Error:', err);
        res.status(500).send('Proxy request failed');
    }
});

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
