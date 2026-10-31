const https = require('https');

function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const httpModule = urlObj.protocol === 'https:' ? https : require('http');

        const req = httpModule.request({
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || { 'User-Agent': 'Mozilla/5.0' },
            timeout: 20000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });

        req.on('error', reject);
        req.on('timeout', () => reject(new Error('Request timeout')));
        req.end();
    });
}

async function getTMDBTitle(tmdbId, type) {
    let apiKey = process.env.TMDB_API_KEYS || process.env.TMDB_API_KEY;
    if (apiKey) {
        try {
            const parsed = JSON.parse(apiKey);
            if (Array.isArray(parsed) && parsed.length > 0) apiKey = parsed[0];
            else if (typeof parsed === 'string') apiKey = parsed;
        } catch(e) {}
    }
    if (!apiKey) return null;

    const tmdbType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${apiKey}`;
    try {
        const res = await makeRequest(url);
        const data = JSON.parse(res.body);
        return { title: data.title || data.name, year: (data.release_date || data.first_air_date || '').substring(0, 4) };
    } catch (e) { return null; }
}

async function getMovieBoxStreams(tmdbId, type, season = 1, episode = 1) {
    try {
        console.log(`\n[MovieBox] 🚀 Starting search for TMDB ID: ${tmdbId}, Type: ${type}`);
        const tmdbInfo = await getTMDBTitle(tmdbId, type);
        if (!tmdbInfo) return [];

        const searchUrl = `https://moviebox-api-jwqw.onrender.com/search?q=${encodeURIComponent(tmdbInfo.title)}`;
        const searchRes = await makeRequest(searchUrl);
        const searchData = JSON.parse(searchRes.body);
        const items = searchData.results || [];
        
        if (items.length === 0) return [];

        // Smart Match: Prioritize exact title, expected type (Movie=1, Series=2), and year
        const expectedType = (type === 'tv' || type === 'series') ? 2 : 1;
        let bestMatch = items.find(item => 
            item.title.toLowerCase() === tmdbInfo.title.toLowerCase() && 
            item.subject_type === expectedType &&
            item.release_date && item.release_date.includes(tmdbInfo.year)
        ) || items.find(item => item.subject_type === expectedType) || items[0];

        console.log(`[MovieBox] 🎯 Selected match: "${bestMatch.title}" (ID: ${bestMatch.subject_id})`);

        let streamUrl = `https://moviebox-api-jwqw.onrender.com/api/stream/${bestMatch.subject_id}`;
        if (type === 'tv' || type === 'series') {
            streamUrl += `?season=${season}&episode=${episode}`;
        }

        const playRes = await makeRequest(streamUrl);
        const playData = JSON.parse(playRes.body);
        
        const streams = [];
        if (playData.streams && playData.streams.length > 0) {
            console.log(`[MovieBox] ✅ Found ${playData.streams.length} streams!`);
            
            playData.streams.forEach(stream => {
                streams.push({
                    name: 'MovieBox',
                    title: `${bestMatch.title} \n ${stream.quality}`,
                    url: stream.url,
                    quality: stream.quality,
                    provider: 'moviebox',
                    headers: stream.headers || {} // Pass the exact headers from your API!
                });
            });
        }

        return streams;
    } catch (error) {
        console.error(`[MovieBox] ❌ Fatal Error:`, error.message);
        return [];
    }
}

module.exports = { getMovieBoxStreams };