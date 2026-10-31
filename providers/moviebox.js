const https = require('https');
const http = require('http');
const crypto = require('crypto');

// Helper for HTTPS requests
function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const req = httpModule.request({
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: 15000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
        });

        req.on('error', reject);
        req.on('timeout', () => reject(new Error('Request timeout')));
        
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// Generate the required timestamp/md5 token
function generateToken() {
    const ts = Math.floor(Date.now() / 1000);
    const md5 = crypto.createHash('md5').update(String(ts).split('').reverse().join('')).digest('hex');
    return `${ts},${md5}`;
}

async function getTMDBTitle(tmdbId, type) {
    let apiKey = process.env.TMDB_API_KEYS || process.env.TMDB_API_KEY;
    if (apiKey) {
        try {
            const parsed = JSON.parse(apiKey);
            if (Array.isArray(parsed) && parsed.length > 0) apiKey = parsed[0];
            else if (typeof parsed === 'string') apiKey = parsed;
        } catch(e) { /* string */ }
    }

    if (!apiKey) {
        console.warn('[MovieBox] ❌ TMDB API key missing.');
        return null;
    }

    const tmdbType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${apiKey}`;
    
    try {
        const res = await makeRequest(url);
        const data = JSON.parse(res.body);
        return {
            title: data.title || data.name,
            year: (data.release_date || data.first_air_date || '').substring(0, 4)
        };
    } catch (e) {
        return null;
    }
}

async function getMovieBoxStreams(tmdbId, type, season = 1, episode = 1) {
    try {
        console.log(`\n[MovieBox] 🚀 Starting search for TMDB ID: ${tmdbId}, Type: ${type}`);
        
        const tmdbInfo = await getTMDBTitle(tmdbId, type);
        if (!tmdbInfo) return [];

        console.log(`[MovieBox] 🔍 Searching for: "${tmdbInfo.title}" (${tmdbInfo.year})`);

        const token = generateToken();
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Origin': 'https://moviebox.ph',
            'Referer': 'https://moviebox.ph/',
            'X-Request-Lang': 'en',
            'X-Client-Info': '{"timezone":"Asia/Kolkata"}',
            'X-Client-Token': token
        };

        // FIXED HOST: h5.aoneroom.com instead of h5-api
        const searchHost = 'https://h5.aoneroom.com/wefeed-h5api-bff/subject/search';
        
        const searchBody = JSON.stringify({ keyword: tmdbInfo.title, page: 1, perPage: 20 });
        const searchRes = await makeRequest(searchHost, {
            method: 'POST',
            headers,
            body: searchBody
        });

        if (searchRes.statusCode !== 200) {
            console.error(`[MovieBox] ❌ Search API failed with status ${searchRes.statusCode}`);
            console.log(`[MovieBox] Response: ${searchRes.body.substring(0, 200)}`);
            return [];
        }

        const searchData = JSON.parse(searchRes.body);
        const items = searchData.data?.items || [];
        
        if (items.length === 0) {
            console.log('[MovieBox] ❌ No search results found.');
            return [];
        }

        console.log(`[MovieBox] ✅ Found ${items.length} results. Top result: "${items[0].title}"`);

        // Find Best Match
        let bestMatch = items.find(item => tmdbInfo.year && item.title.includes(tmdbInfo.year)) || items[0];
        console.log(`[MovieBox] 🎯 Selected match: "${bestMatch.title}"`);

        let subjectId = bestMatch.subjectId;
        let detailPath = bestMatch.detailPath;

        if (!subjectId) {
            console.log('[MovieBox] ❌ Subject ID missing.');
            return [];
        }

        const se = (type === 'tv' || type === 'series') ? season : 0;
        const ep = (type === 'tv' || type === 'series') ? episode : 0;

        // FIXED HOST FOR PLAY URL
        const playUrl = `https://h5.aoneroom.com/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(detailPath)}`;
        
        const playRes = await makeRequest(playUrl, { headers });
        
        if (playRes.statusCode !== 200) {
            console.error(`[MovieBox] ❌ Play API failed with status ${playRes.statusCode}`);
            console.log(`[MovieBox] Response: ${playRes.body.substring(0, 200)}`);
            return [];
        }

        const playData = JSON.parse(playRes.body);

        const streams = [];
        const mbHeaders = {
            'Referer': 'https://moviebox.ph/',
            'Origin': 'https://moviebox.ph'
        };

        if (playData.data?.streams && playData.data.streams.length > 0) {
            console.log(`[MovieBox] ✅ Found ${playData.data.streams.length} streams!`);
            playData.data.streams.forEach(stream => {
                streams.push({
                    name: 'MovieBox',
                    title: `${bestMatch.title} \n ${stream.quality || 'HD'}`,
                    url: stream.url,
                    quality: stream.quality || '1080p',
                    provider: 'moviebox',
                    headers: mbHeaders
                });
            });
        } else if (playData.data?.hls && playData.data.hls.length > 0) {
            console.log(`[MovieBox] ✅ Found ${playData.data.hls.length} HLS streams!`);
            playData.data.hls.forEach(stream => {
                streams.push({
                    name: 'MovieBox',
                    title: `${bestMatch.title} \n ${stream.quality || 'HD'}`,
                    url: stream.url,
                    quality: stream.quality || '1080p',
                    provider: 'moviebox',
                    headers: mbHeaders
                });
            });
        } else {
            console.log('[MovieBox] ❌ Play API returned no streams.');
            console.log('[MovieBox Debug Play Data]:', JSON.stringify(playData).substring(0, 500));
        }

        return streams;

    } catch (error) {
        console.error(`[MovieBox] ❌ Fatal Error:`, error.message);
        return [];
    }
}

module.exports = {
    getMovieBoxStreams
};