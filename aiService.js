// aiService.js

const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const axios = require('axios');

// --- Initialization ---
// Explicitly assign API keys from process.env (loaded by dotenv in index.js)
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

console.log('=== API Key Debug ===');
console.log('GEMINI_API_KEY exists:', !!GEMINI_KEY);
console.log('GEMINI_API_KEY length:', GEMINI_KEY ? GEMINI_KEY.length : 0);
console.log('GEMINI_API_KEY first 10 chars:', GEMINI_KEY ? GEMINI_KEY.substring(0, 10) : 'N/A');
console.log('OPENAI_API_KEY exists:', !!OPENAI_KEY);
console.log('=====================');

if (!GEMINI_KEY || !OPENAI_KEY) {
    console.error("CRITICAL: One or both API keys are missing. Ensure GEMINI_API_KEY and OPENAI_API_KEY are set in your .env file.");
    // Optionally exit the process or throw an error here if keys are mandatory.
}

// Initialize AI clients
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Helper function to call Gemini v1 API directly (bypassing SDK's v1beta)
async function callGeminiV1API(model, prompt, config = {}) {
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`;
    
    const requestBody = {
        contents: [{
            parts: [{
                text: prompt
            }]
        }]
    };
    
    if (config.generationConfig) {
        requestBody.generationConfig = config.generationConfig;
    }
    
    try {
        const response = await axios.post(`${url}?key=${GEMINI_KEY}`, requestBody, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error('Gemini API Error:', error.response?.data || error.message);
        throw error;
    }
}


// --- Configuration ---
// Using v1 API model names
const GEMINI_MODEL_EXTRACT = "gemini-2.5-flash"; 
const GEMINI_MODEL_GUIDE = "gemini-2.5-flash"; // v1 might not have pro, using flash   
const CHATGPT_MODEL_EXTRACT = "gpt-4o-mini";    
const CHATGPT_MODEL_GUIDE = "gpt-4o";           


// 1. Define the schema for a single Feature Object
const featureObjectSchema = {
// ... (Remains the same) ...
    type: "object",
    properties: {
        featureName: { type: "string", description: "A concise, descriptive title for the product update or feature." },
        featureSummary: { type: "string", description: "A 2-3 sentence technical summary of what the new feature does or how the update works." },
        potentialUseCases: {
            type: "array",
            items: { type: "string" },
            description: "List three distinct, real-world use cases that this feature could address."
        }
    },
    required: ["featureName", "featureSummary", "potentialUseCases"]
};

// 2. Define the TOP-LEVEL schema for Gemini (array)
const geminiExtractionSchema = {
    type: "array",
    items: featureObjectSchema
};

// 3. Define the TOP-LEVEL schema for OpenAI (object wrapper)
const openaiExtractionSchema = {
    type: "object",
    properties: {
        extractedFeatures: { // <-- Key to hold the array
            type: "array",
            description: "A list of all extracted technical features and their associated use cases.",
            items: featureObjectSchema
        }
    },
    required: ["extractedFeatures"]
};


// ------------------------------------------
// Extraction Function Wrapper
// ------------------------------------------

async function extractFeatures(articleText, provider = 'gemini') {
// ... (Logic remains the same, using the explicitly initialized 'ai' and 'openai' objects) ...
    const prompt = `
        Analyze the following Red Hat news article. Your task is to extract all new product updates, technical features, or significant value-added stories.
        If the article is primarily corporate news, opinion, or non-technical, return an empty array (or a wrapper object with an empty array).
        Otherwise, for each significant technical update, provide a descriptive name, a technical summary, and three distinct, real-world use cases.
        Return ONLY the JSON object that strictly adheres to the provided schema.

        ARTICLE CONTENT:
        ---
        ${articleText}
        ---
    `;

    try {
        let jsonText;
        let finalResult = [];

        if (provider === 'openai') {
            const response = await openai.chat.completions.create({
                model: CHATGPT_MODEL_EXTRACT,
                messages: [{ role: "user", content: prompt }],
                tools: [{
                    type: "function",
                    function: {
                        name: "extract_features",
                        description: "Extracts product features and use cases from a Red Hat announcement article.",
                        parameters: openaiExtractionSchema,
                    }
                }],
                tool_choice: { type: "function", function: { name: "extract_features" } },
                temperature: 0.1,
            });
            
            const callArguments = response.choices[0].message.tool_calls[0].function.arguments;
            jsonText = callArguments; 
            
            const parsedObject = JSON.parse(jsonText);
            finalResult = parsedObject.extractedFeatures || [];

        } else { // 'gemini' - using v1 API directly
            console.log(`[DEBUG] Calling Gemini v1 API with model: ${GEMINI_MODEL_EXTRACT}`);
            console.log(`[DEBUG] API Key present: ${!!GEMINI_KEY}`);
            
            const enhancedPrompt = prompt + "\n\nIMPORTANT: Return ONLY valid JSON array format, no other text.";
            
            jsonText = await callGeminiV1API(GEMINI_MODEL_EXTRACT, enhancedPrompt, {
                generationConfig: { temperature: 0.1 }
            });
            
            console.log(`[DEBUG] Response received:`, !!jsonText);
            
            // Clean and parse JSON
            jsonText = jsonText.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
            finalResult = JSON.parse(jsonText);
        }

        return finalResult;

    } catch (error) {
        console.error(`[${provider.toUpperCase()}] API Extraction Error:`, error);
        return [];
    }
}


// Helper to download image from Base64 or URL (Imagen returns Base64 by default)
async function saveBase64Image(base64Data) {
    const fileName = `infographic-${Date.now()}-${Math.floor(Math.random() * 10000)}.png`;
    const filePath = path.join(__dirname, 'public', 'images', 'generated', fileName);
    
    return new Promise((resolve, reject) => {
        fs.writeFile(filePath, base64Data, 'base64', (err) => {
            if (err) {
                reject(err);
            } else {
                resolve(`/images/generated/${fileName}`);
            }
        });
    });
}

// Helper to generate infographic HTML visualization
async function generateInfographicHTML(feature, useCase) {
    try {
        console.log("Generating business value infographic...");
        const prompt = `Create an HTML/CSS infographic visualization that shows the business value of "${feature.featureName}" for the use case: "${useCase}".

The infographic should be a complete HTML snippet (div with inline styles) that:
- Visualizes the transformation or business impact in a clear, professional way
- Uses a modern, corporate design with Red Hat colors (red: #cc0000, blue: #0066cc, gray: #777)
- Shows before/after comparison OR a flow diagram OR key metrics
- Is visually striking and easy for salespeople to understand at a glance
- Uses flexbox or grid for layout, boxes/cards for content
- Includes icons represented by unicode symbols or colored boxes
- Should be 100% width, max 600px height
- IMPORTANT: Use box-sizing: border-box and max-width: 100% on all elements to prevent overflow
- Use padding and margins in percentages or relative units (em, rem) not fixed pixels
- Ensure all text is responsive and wraps properly
- Set overflow: hidden or overflow: auto on container elements

Return ONLY the HTML div with inline styles, no explanations.`;
        
        const htmlInfographic = await callGeminiV1API(GEMINI_MODEL_GUIDE, prompt, {
            generationConfig: { temperature: 0.7 }
        });
        
        return htmlInfographic.replace(/```(html)?/g, '').trim();

    } catch (error) {
        console.error("Infographic Generation Error:", error);
        return null;
    }
}

// ------------------------------------------
// Guide Generation Wrapper
// ------------------------------------------

async function generateGuide(feature, useCase, provider = 'gemini') {
    const guidePrompt = `
// ... (Prompt remains the same) ...
        You are a technical writer. Write a comprehensive, step-by-step technical guide for a user.
        The guide should focus on the new Red Hat feature: **${feature.featureName}** (Summary: ${feature.featureSummary}).
        The entire guide must be contextualized around the following real-world scenario/use case: **${useCase}**.

        The guide must be returned as a complete HTML snippet (excluding <html>, <head>, and <body> tags, but including <h2>, <p>, <h3>, <ul>, and <code> tags).
        
        IMPORTANT: Do NOT include any <h1> tags, images, or infographic content. The infographic will be added separately at the top of the page.
        
        The guide should be professional, instructive, and include ONLY the following sections:
        1. An introduction relating the feature to the use case.
        2. Prerequisites (e.g., 'RHEL 9', 'OpenShift Cluster access').
        3. A section of at least 3-10 actionable, technical steps/commands with brief explanations.
        4. A conclusion on the value proposition.
    `;

    try {
        // Start infographic HTML generation in parallel with text generation
        const infographicPromise = generateInfographicHTML(feature, useCase);
        
        let textPromise;
        if (provider === 'openai') {
            textPromise = openai.chat.completions.create({
                model: CHATGPT_MODEL_GUIDE,
                messages: [{ role: "user", content: guidePrompt }],
                temperature: 0.7,
            }).then(res => res.choices[0].message.content);

        } else { // 'gemini' - using v1 API
            textPromise = callGeminiV1API(GEMINI_MODEL_GUIDE, guidePrompt, {
                generationConfig: { temperature: 0.7 }
            });
        }

        const [infographicResult, textResult] = await Promise.all([infographicPromise, textPromise]);

        let html = textResult.replace(/```(html)?/g, '').trim();
        
        // Remove any infographic-related sections that the AI might have generated
        // Match from "Infographic" heading to the next heading or end of content
        html = html.replace(/<h[1-6][^>]*>.*?Infographic.*?<\/h[1-6]>[\s\S]*?(?=<h[1-6]|$)/gi, '');
        html = html.replace(/<h[1-6][^>]*>.*?Business Value Visualization.*?<\/h[1-6]>[\s\S]*?(?=<h[1-6]|$)/gi, '');
        
        // Remove any standalone image tags that might have been generated
        html = html.replace(/<img[^>]*>/gi, '');
        
        // Clean up multiple consecutive line breaks and empty elements
        html = html.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
        html = html.replace(/<div[^>]*>\s*<\/div>/gi, '');
        html = html.replace(/<section[^>]*>\s*<\/section>/gi, '');
        html = html.trim();

        return {
            infographicHtml: infographicResult,
            html: html
        };

    } catch (error) {
        console.error(`[${provider.toUpperCase()}] API Guide Generation Error:`, error);
        return {
            infographicHtml: null,
            html: "<h3>Error Generating Guide</h3><p>Could not generate the technical guide using the selected AI provider.</p>"
        };
    }
}

module.exports = { extractFeatures, generateGuide };