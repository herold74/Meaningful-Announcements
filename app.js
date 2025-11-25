// index.js

// 1. Load environment variables from .env file FIRST
require('dotenv').config(); 

const express = require('express');
const hbs = require('hbs');
const RSSParser = require('rss-parser');
const { extractFeatures, generateGuide } = require('./aiService'); 

// --- Initialization ---
const app = express();
const port = 3000;
const rssParser = new RSSParser();

// Use the main blog RSS feed
const REDHAT_RSS_URL = 'https://www.redhat.com/en/rss/blog'; 

// ----------------------------------------------------
// 🔥 IN-MEMORY CACHE FOR ARTICLES AND FEATURES
// This global variable will store the extracted data.
// Structure: Array of { title, pubDate, link, features }
let extractedArticlesCache = []; 
// ----------------------------------------------------

// --- Configure Express and HBS ---
app.set('view engine', 'hbs');
app.set('views', __dirname + '/views');
app.use(express.static('public'));

// Register the custom Handlebars helper for checking equality
hbs.registerHelper('if_eq', function(a, b, opts) {
    if (a === b) {
        return opts.fn(this);
    } else {
        return opts.inverse(this);
    }
});


// --- Helper function to get the current AI provider ---
function getProvider(req) {
    // Note: We'll use the provider from the query/cache, but this function
    // still determines the provider for the initial extraction run.
    const provider = req.query.provider && req.query.provider.toLowerCase() === 'openai' ? 'openai' : 'gemini';
    return provider;
}


// --- Routes ---

app.get('/', async (req, res) => {
    // Determine provider for this extraction run
    const provider = getProvider(req);
    
    // --- Only refetch and re-extract if the cache is empty ---
    if (extractedArticlesCache.length === 0 || req.query.refresh === 'true') {
        try {
            console.log(`[Cache Miss] Fetching RSS feed and running ${provider.toUpperCase()} extraction...`);
            const feed = await rssParser.parseURL(REDHAT_RSS_URL);
            
            // Clear the old cache (if we are refreshing) and populate the new one
            extractedArticlesCache = []; 
            
            // Process the first 5 articles
            for (const item of feed.items.slice(0, 10)) {
                const articleContent = item.content || item.contentSnippet;
                
                // --- Feature Extraction ---
                const extractedFeatures = await extractFeatures(articleContent, provider);

                if (extractedFeatures.length > 0) {
                    extractedArticlesCache.push({
                        title: item.title,
                        pubDate: item.pubDate,
                        link: item.link,
                        // Store the features AND the provider used for extraction
                        features: extractedFeatures,
                        extractionProvider: provider 
                    });
                }
            }
            console.log(`[Cache Hit] Stored ${extractedArticlesCache.length} articles.`);

        } catch (error) {
            console.error('Error fetching/parsing RSS feed:', error);
            return res.status(500).send('Error fetching announcements.');
        }
    } else {
        console.log(`[Cache Hit] Serving ${extractedArticlesCache.length} articles from memory.`);
    }

    res.render('index', { 
        title: `Red Hat Announcement Analyzer (Provider: ${provider.toUpperCase()})`,
        announcements: extractedArticlesCache, // Use the cached data
        currentProvider: provider,
        otherProvider: provider === 'gemini' ? 'openai' : 'gemini'
    });
});


// Route to generate and display the specific guide
app.get('/guide/:articleIndex/:featureIndex/:useCaseIndex', async (req, res) => {
    
    // 1. Validate the cache exists
    if (extractedArticlesCache.length === 0) {
        return res.status(503).send('Cache empty. Please visit the homepage first to load data.');
    }

    // 2. Retrieve data from the in-memory cache
    const articleIndex = parseInt(req.params.articleIndex, 10);
    const featureIndex = parseInt(req.params.featureIndex, 10);
    const useCaseIndex = parseInt(req.params.useCaseIndex, 10);

    const article = extractedArticlesCache[articleIndex];
    
    if (!article || !article.features || article.features.length <= featureIndex) {
        return res.status(404).send('Feature or Article not found in cache.');
    }

    const feature = article.features[featureIndex];
    
    if (!feature.potentialUseCases || feature.potentialUseCases.length <= useCaseIndex) {
        return res.status(404).send('Use Case not found in cache.');
    }

    const useCase = feature.potentialUseCases[useCaseIndex];
    
    // Use the provider that was originally used to extract the features
    const generationProvider = article.extractionProvider || getProvider(req);
    
    try {
        console.log(`Generating Guide using ${generationProvider.toUpperCase()} for cached feature: ${feature.featureName}`);
        
        // --- Guide Generation (This is still an API call) ---
        const guideHtml = await generateGuide(feature, useCase, generationProvider);

        res.render('guide', {
            title: `Guide: ${feature.featureName} [${generationProvider.toUpperCase()}]`,
            articleTitle: article.title,
            featureName: feature.featureName,
            useCase: useCase,
            guideHtml: guideHtml,
            currentProvider: generationProvider
        });

    } catch (error) {
        console.error('Error generating guide:', error);
        res.status(500).send('Error generating the guide.');
    }
});


// --- Start Server ---
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`AI Keys loaded successfully from .env`);
});