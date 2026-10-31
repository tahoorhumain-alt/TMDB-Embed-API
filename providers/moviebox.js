const https = require('https');

// Helper to make HTTP requests
function makeRequest(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }).on('error', reject);
    });
}

// Get TMDB Title
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

        // 1. Search your MovieBox API
        const searchUrl = `https://moviebox-api-jwqw.onrender.com/search?q=${encodeURIComponent(tmdbInfo.title)}`;
        console.log(`[MovieBox] 🔍 Searching: ${searchUrl}`);
        
        const searchRes = await makeRequest(searchUrl);
        const searchData = JSON.parse(searchRes.body);
        const items = searchData.results || [];
        
        if (items.length === 0) {
            console.log('[MovieBox] ❌ No search results found.');
            return [];
        }

        // 2. Find Best Match
        let bestMatch = items.find(item => tmdbInfo.year && item.release_date?.includes(tmdbInfo.year)) || items[0];
        console.log(`[MovieBox] 🎯 Selected match: "${bestMatch.title}" (ID: ${bestMatch.subject_id})`);

        let subjectId = bestMatch.subject_id;
        if (!subjectId) return [];

        // 3. Fetch Stream
        // Note: If it's a TV show, some wrappers require ?season=X&episode=Y at the end
        let streamUrl = `https://moviebox-api-jwqw.onrender.com/api/stream/${subjectId}`;
        if (type === 'tv' || type === 'series') {
            streamUrl += `?season=${season}&episode=${episode}`;
        }

        console.log(`[MovieBox] 🎬 Fetching stream: ${streamUrl}`);
        const playRes = await makeRequest(streamUrl);
        
        if (playRes.statusCode !== 200) {
            console.error(`[MovieBox] ❌ Stream API failed with status ${playRes.statusCode}`);
            return [];
        }

        const playData = JSON.parse(playRes.body);
        
        // 4. Format Streams
        // (Assuming your API returns an array like playData.streams or playData.data)
        // Adjust the mapping below based on what the /api/stream/ endpoint returns
        const streams = [];
        const rawStreams = playData.streams || playData.data || playData; 

        if (Array.isArray(rawStreams) && rawStreams.length > 0) {
            console.log(`[MovieBox] ✅ Found ${rawStreams.length} streams!`);
            rawStreams.forEach(stream => {
                streams.push({
                    name: 'MovieBox',
                    title: `${bestMatch.title} \n ${stream.quality || 'HD'}`,
                    url: stream.url || stream.link, // Adjust based on API response
                    quality: stream.quality || stream.resolution || '1080p',
                    provider: 'moviebox',
                    headers: {
                        'Referer': 'https://moviebox.ph/',
                        'Origin': 'https://moviebox.ph'
                    }
                });
            });
        } else {
            console.log('[MovieBox] ❌ Stream API returned no streams.');
            console.log('[MovieBox Debug]:', JSON.stringify(playData).substring(0, 200));
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