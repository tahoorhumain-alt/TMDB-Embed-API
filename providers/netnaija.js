const https = require('https');
const http = require('http');
const crypto = require('crypto');

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

// Generate the required timestamp/md5 token for NetNaija API
function generateToken() {
    const ts = Math.floor(Date.now() / 1000);
    const md5 = crypto.createHash('md5').update(String(ts).split('').reverse().join('')).digest('hex');
    return `${ts},${md5}`;
}

async function getTMDBTitle(tmdbId, type) {
    let apiKey = process.env.TMDB_API_KEYS;
    if (apiKey) {
        try {
            const parsed = JSON.parse(apiKey);
            if (Array.isArray(parsed) && parsed.length > 0) apiKey = parsed[0];
            else if (typeof parsed === 'string') apiKey = parsed;
        } catch(e) {
            // It's a plain string
        }
    }
    if (!apiKey) apiKey = process.env.TMDB_API_KEY;

    if (!apiKey) {
        console.warn('[NetNaija] TMDB API key missing');
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
        console.error('[NetNaija] TMDB fetch failed:', e.message);
        return null;
    }
}

async function getNetNaijaStreams(tmdbId, type, season = 1, episode = 1) {
    try {
        console.log(`[NetNaija] Fetching streams for TMDB ID: ${tmdbId}, Type: ${type}`);
        
        const tmdbInfo = await getTMDBTitle(tmdbId, type);
        if (!tmdbInfo || !tmdbInfo.title) {
            return [];
        }

        console.log(`[NetNaija] Searching for: ${tmdbInfo.title} (${tmdbInfo.year})`);

        const token = generateToken();
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Origin': 'https://netnaija.film',
            'Referer': 'https://netnaija.film/',
            'X-Request-Lang': 'en',
            'X-Client-Info': '{"timezone":"Asia/Kolkata"}',
            'X-Client-Token': token
        };

        // 1. Search NetNaija
        const searchBody = JSON.stringify({ keyword: tmdbInfo.title, page: 1, perPage: 20 });
        const searchRes = await makeRequest('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/search', {
            method: 'POST',
            headers,
            body: searchBody
        });

        const searchData = JSON.parse(searchRes.body);
        const items = searchData.data?.items || [];
        
        if (items.length === 0) {
            console.log('[NetNaija] No search results found');
            return [];
        }

        // 2. Find best match (Prioritizing Year)
        let bestMatch = items.find(item => tmdbInfo.year && item.title.includes(tmdbInfo.year)) || items[0];

        console.log(`[NetNaija] Selected match: ${bestMatch.title}`);

        let subjectId = bestMatch.subjectId;
        let detailPath = bestMatch.detailPath;

        if (!subjectId) {
            console.log('[NetNaija] Subject ID missing');
            return [];
        }

        const se = (type === 'tv' || type === 'series') ? season : 0;
        const ep = (type === 'tv' || type === 'series') ? episode : 0;

        const playUrl = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(detailPath)}`;
        
        // 3. Get Play URL
        const playRes = await makeRequest(playUrl, { headers });
        const playData = JSON.parse(playRes.body);

        const streams = [];
        const netNaijaHeaders = {
            'Referer': 'https://netnaija.film/',
            'Origin': 'https://netnaija.film'
        };

        if (playData.data?.streams && playData.data.streams.length > 0) {
            playData.data.streams.forEach(stream => {
                streams.push({
                    name: 'NetNaija',
                    title: `${bestMatch.title} \n ${stream.quality || 'HD'}`,
                    url: stream.url,
                    quality: stream.quality || '1080p',
                    provider: 'netnaija',
                    headers: netNaijaHeaders
                });
            });
        } else if (playData.data?.hls && playData.data.hls.length > 0) {
            playData.data.hls.forEach(stream => {
                streams.push({
                    name: 'NetNaija',
                    title: `${bestMatch.title} \n ${stream.quality || 'HD'}`,
                    url: stream.url,
                    quality: stream.quality || '1080p',
                    provider: 'netnaija',
                    headers: netNaijaHeaders
                });
            });
        }

        console.log(`[NetNaija] Found ${streams.length} streams`);
        return streams;

    } catch (error) {
        console.error(`[NetNaija] Error getting streams:`, error.message);
        return [];
    }
}

module.exports = {
    getNetNaijaStreams
};