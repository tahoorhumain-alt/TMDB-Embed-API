const { MovieboxSession, search, getMovieDetails, getSeriesDetails, getMovieStreamUrl, getEpisodeStreamUrl } = require('moviebox-js-sdk');
const https = require('https');

// Helper to get TMDB title
function getTMDBTitle(tmdbId, type) {
    return new Promise((resolve) => {
        let apiKey = process.env.TMDB_API_KEYS || process.env.TMDB_API_KEY;
        if (apiKey) {
            try {
                const parsed = JSON.parse(apiKey);
                if (Array.isArray(parsed) && parsed.length > 0) apiKey = parsed[0];
                else if (typeof parsed === 'string') apiKey = parsed;
            } catch (e) { /* keep as string */ }
        }

        if (!apiKey) {
            console.warn('[MovieBox] ❌ TMDB API key missing.');
            return resolve(null);
        }

        const tmdbType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
        const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${apiKey}`;

        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({
                        title: json.title || json.name,
                        year: (json.release_date || json.first_air_date || '').substring(0, 4)
                    });
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

async function getMovieBoxStreams(tmdbId, type, season = null, episode = null) {
    try {
        console.log(`\n[MovieBox] 🚀 Starting search for TMDB ID: ${tmdbId}, Type: ${type}`);
        
        const tmdbInfo = await getTMDBTitle(tmdbId, type);
        if (!tmdbInfo) return [];

        console.log(`[MovieBox] 🔍 Searching for: "${tmdbInfo.title}" (${tmdbInfo.year})`);

        // Initialize Session (handles cookies/mirrors automatically)
        const session = new MovieboxSession({
            host: 'h5.aoneroom.com', // Standard MovieBox API host
            mirrorHosts: ['h5.aoneroom.com', 'movieboxapp.in']
        });

        // 1. Search MovieBox
        const searchResults = await search(session, { query: tmdbInfo.title });
        
        if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
            console.log('[MovieBox] ❌ No search results found.');
            return [];
        }

        // 2. Find Best Match
        // Prioritize exact year match, otherwise take the first result
        let bestMatch = searchResults.results.find(r => r.title.includes(tmdbInfo.year)) || searchResults.results[0];
        
        console.log(`[MovieBox] 🎯 Selected match: "${bestMatch.title}" (DetailPath: ${bestMatch.detailPath})`);

        // 3. Extract Stream
        let streamData;
        if (type === 'tv' || type === 'series') {
            if (!season || !episode) {
                console.warn('[MovieBox] ❌ TV Series requested but season/episode missing.');
                return [];
            }
            console.log(`[MovieBox] 🎬 Fetching stream for S${season}E${episode}...`);
            // Fetch details to get episode info if needed (SDK may handle it directly)
            streamData = await getEpisodeStreamUrl(session, {
                detailPath: bestMatch.detailPath,
                season: parseInt(season),
                episode: parseInt(episode),
                quality: 'best'
            });
        } else {
            console.log(`[MovieBox] 🎬 Fetching movie stream...`);
            streamData = await getMovieStreamUrl(session, {
                detailPath: bestMatch.detailPath,
                quality: 'best'
            });
        }

        if (!streamData || !streamData.stream || !streamData.stream.url) {
            console.log('[MovieBox] ❌ Failed to extract stream URL.');
            return [];
        }

        const finalUrl = streamData.stream.url;
        console.log(`[MovieBox] ✅ Stream found! URL: ${finalUrl.substring(0, 50)}...`);

        // 4. Return in API Format
        return [{
            name: 'MovieBox',
            title: `${bestMatch.title} \n ${streamData.stream.quality || 'HD'}`,
            url: finalUrl,
            quality: streamData.stream.quality || '1080p',
            provider: 'moviebox',
            headers: {
                'Referer': 'https://moviebox.ph/',
                'Origin': 'https://moviebox.ph/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        }];

    } catch (error) {
        console.error(`[MovieBox] ❌ Fatal Error:`, error.message);
        return [];
    }
}

module.exports = {
    getMovieBoxStreams
};