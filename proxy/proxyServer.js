const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const app = express();

// Enable CORS for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

// The universal proxy handler
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    const referer = req.query.referer || '';

    if (!targetUrl) return res.status(400).send('Missing url');

    // Unwrap hbplay.pages.dev base64 if present
    if (targetUrl.includes('hbplay.pages.dev')) {
        const urlObj = new URL(targetUrl);
        const uParam = urlObj.searchParams.get('u');
        if (uParam) {
            targetUrl = Buffer.from(uParam, 'base64').toString('utf-8');
        }
    }

    try {
        const isHls = targetUrl.includes('.m3u8');
        
        // Determine the base URL for resolving relative paths
        const urlObj = new URL(targetUrl);
        const baseUrl = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

        const fetchOptions = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(referer ? { 'Referer': referer } : {})
            }
        };

        const response = await fetch(targetUrl, fetchOptions);

        if (!response.ok) {
            return res.status(response.status).send('Upstream error');
        }

        // --- HANDLE HLS (.m3u8) ---
        if (isHls) {
            let content = await response.text();
            
            // Rewrite every non-comment line to go through our proxy
            const lines = content.split('\n');
            const rewrittenLines = lines.map(line => {
                const trimmed = line.trim();
                // Skip empty lines and comments/tags
                if (trimmed === '' || trimmed.startsWith('#')) {
                    return line;
                }
                
                // It's a segment or sub-playlist URL
                let absoluteUrl = trimmed;
                if (!trimmed.startsWith('http')) {
                    // Resolve relative URL against the base URL
                    absoluteUrl = new URL(trimmed, baseUrl).href;
                }
                
                // Point the segment back to our proxy
                return `/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(rewrittenLines.join('\n'));
            return;
        }

        // --- HANDLE BINARY / VIDEO FILES ---
        // Stream the response directly to the client
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
        
        // Pass through range requests for video seeking
        if (response.headers.get('content-length')) {
            res.setHeader('Content-Length', response.headers.get('content-length'));
        }
        if (response.headers.get('content-range')) {
            res.setHeader('Content-Range', response.headers.get('content-range'));
            res.status(206);
        }

        response.body.pipe(res);

    } catch (err) {
        console.error('Proxy error:', err);
        res.status(500).send('Proxy request failed');
    }
});

// ... rest of your existing API routes (streams, etc.) ...
// Make sure to keep your existing /api/streams/... routes here

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
