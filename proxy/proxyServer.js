const fetch = require('node-fetch');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function createProxyRoutes(app) {
    
    app.get('/proxy', async (req, res) => {
        let targetUrl = req.query.url;
        const referer = req.query.referer || '';

        if (!targetUrl) return res.status(400).send('Missing url parameter');

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');

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

        if (isHls) {
            try {
                const response = await fetch(targetUrl, fetchOptions);
                if (!response.ok) return res.status(response.status).send('HLS Upstream error');

                let content = await response.text();
                const urlObj = new URL(targetUrl);
                const baseUrl = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

                const lines = content.split('\n');
                const rewrittenLines = lines.map(line => {
                    const trimmed = line.trim();
                    if (trimmed === '' || trimmed.startsWith('#')) return line; 
                    
                    let absoluteUrl = trimmed;
                    if (!trimmed.startsWith('http')) {
                        absoluteUrl = new URL(trimmed, baseUrl).href;
                    }
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}`;
                });

                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.send(rewrittenLines.join('\n'));
            } catch (err) {
                console.error('HLS Proxy Error:', err);
                res.status(500).send('HLS Proxy failed');
            }
            return;
        }

        if (isMkv) {
            res.setHeader('Content-Type', 'video/mp4');
            
            const ffmpeg = spawn(ffmpegPath, [
                '-headers', `Referer: ${referer}\r\n`,
                '-i', targetUrl,
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-ac', '2',
                '-ar', '44100',
                '-b:a', '192k',
                '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                '-f', 'mp4',
                'pipe:1'
            ]);

            ffmpeg.stdout.pipe(res);
            ffmpeg.stderr.on('data', (data) => { /* console.log(`ffmpeg: ${data}`); */ });
            req.on('close', () => { ffmpeg.kill('SIGKILL'); });
            ffmpeg.on('error', (err) => {
                console.error('FFmpeg Error:', err);
                if (!res.headersSent) res.status(500).send('FFmpeg execution failed');
            });
            return;
        }

        try {
            if (req.headers.range) {
                fetchOptions.headers['Range'] = req.headers.range;
            }

            const response = await fetch(targetUrl, fetchOptions);
            
            if (!response.ok && response.status !== 206) {
                return res.status(response.status).send('Upstream error');
            }

            res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
            
            if (response.headers.get('content-length')) {
                res.setHeader('Content-Length', response.headers.get('content-length'));
            }
            if (response.headers.get('content-range')) {
                res.setHeader('Content-Range', response.headers.get('content-range'));
                res.status(206);
            }

            response.body.pipe(res);
        } catch (err) {
            console.error('Binary Proxy Error:', err);
            res.status(500).send('Proxy request failed');
        }
    });
}

function processStreamsForProxy(streams, serverUrl) {
    if (!Array.isArray(streams)) return streams;
    
    return streams.map(s => {
        if (!s || !s.url || typeof s.url !== 'string') return s;
        
        if (s.url.includes('vidsrc') || s.url.includes('vidrift') || s.url.includes('embed') || s.isEmbed) {
            return s;
        }
        
        return { 
            ...s, 
            url: `${serverUrl}/proxy?url=${encodeURIComponent(s.url)}` 
        };
    });
}

module.exports = { createProxyRoutes, processStreamsForProxy };
