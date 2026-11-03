const https = require('https');
const http = require('http');

// Use your actual deployed API URL here
const MOVIEBOX_API_URL = process.env.MOVIEBOX_API_URL || 'https://moviebox-api-1-ry4d.onrender.com';

function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const httpModule = urlObj.protocol === 'https:' ? https : http;

        const req = httpModule.request({
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || { 'User-Agent': 'Mozilla/5.0' },
            timeout: 20000 // 20 seconds timeout (Render free tier might take a while to wake up)
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

// Helper to safely parse JSON without crashing the server
function safeJsonParse(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}

async function getTMDBTitle(tmdbId, type) {
    let apiKey = process.env.TMDB_API_KEYS || process.env.TMDB_API_KEY;
    
    if (apiKey) {
        try {
            const parsed = JSON.parse(apiKey);
            if (Array.isArray(parsed) && parsed.length > 0) apiKey = parsed[0];
            else if (typeof parsed === 'string') apiKey = parsed;
        } catch(e) {
            // If it's a raw string and not JSON, just use it as is
        }
    }
    
    if (!apiKey) return null;

    const tmdbType = (type === 'tv' || type === 'series') ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${apiKey}`;
    
    try {
        const res = await makeRequest(url);
        const data = safeJsonParse(res.body);
        
        if (!data) return null;
        
        return { 
            title: data.title || data.name, 
            year: (data.release_date || data.first_air_date || '').substring(0, 4) 
        };
    } catch (e) { 
        console.error(`[TMDB] Error fetching title:`, e.message);
        return null; 
    }
}

async function getMovieBoxStreams(tmdbId, type, season = 1, episode = 1) {
    try {
        console.log(`\n[MovieBox] 🚀 Starting search for TMDB ID: ${tmdbId}, Type: ${type}`);
        
        const tmdbInfo = await getTMDBTitle(tmdbId, type);
        if (!tmdbInfo || !tmdbInfo.title) {
            console.log(`[MovieBox] ❌ Could not get TMDB info.`);
            return [];
        }

        const searchUrl = `${MOVIEBOX_API_URL}/search?q=${encodeURIComponent(tmdbInfo.title)}`;
        const searchRes = await makeRequest(searchUrl);
        const searchData = safeJsonParse(searchRes.body);
        
        if (!searchData || !searchData.results || searchData.results.length === 0) {
            console.log(`[MovieBox] ❌ No search results found for "${tmdbInfo.title}"`);
            return [];
        }

        const items = searchData.results;

        // Smart Match: Prioritize exact title, expected type (Movie=1, Series=2), and year
        const expectedType = (type === 'tv' || type === 'series') ? 2 : 1;
        
        // Filter by type first
        let typeMatches = items.filter(item => item.subject_type === expectedType);
        if (typeMatches.length === 0) typeMatches = items; // Fallback if no type matches

        // Then try to find exact title + year match
        let bestMatch = typeMatches.find(item => 
            item.title.toLowerCase() === tmdbInfo.title.toLowerCase() && 
            tmdbInfo.year && item.release_date && item.release_date.includes(tmdbInfo.year)
        );
        
        // Fallback to exact title match
        if (!bestMatch) {
            bestMatch = typeMatches.find(item => item.title.toLowerCase() === tmdbInfo.title.toLowerCase());
        }

        // Final fallback to the first result
        if (!bestMatch) bestMatch = typeMatches[0];

        console.log(`[MovieBox] 🎯 Selected match: "${bestMatch.title}" (ID: ${bestMatch.subject_id})`);

        let streamUrl = `${MOVIEBOX_API_URL}/api/stream/${bestMatch.subject_id}`;
        if (type === 'tv' || type === 'series') {
            streamUrl += `?season=${season}&episode=${episode}`;
        }

        const playRes = await makeRequest(streamUrl);
        const playData = safeJsonParse(playRes.body);
        
        if (!playData || !playData.streams || playData.streams.length === 0) {
            console.log(`[MovieBox] ❌ No streams found for subject ID: ${bestMatch.subject_id}`);
            return [];
        }

        console.log(`[MovieBox] ✅ Found ${playData.streams.length} streams!`);
        
        const streams = [];
        playData.streams.forEach(stream => {
            streams.push({
                name: 'MovieBox',
                title: `${bestMatch.title} \n ${stream.quality || 'HD'}`,
                url: stream.url,
                quality: stream.quality || 'HD',
                provider: 'moviebox',
                headers: stream.headers || {} // Pass the exact headers from the API
            });
        });

        return streams;

    } catch (error) {
        console.error(`[MovieBox] ❌ Fatal Error:`, error.message);
        return [];
    }
}

module.exports = { getMovieBoxStreams };
