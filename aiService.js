// aiService.js

const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");

// --- Initialization ---
// Ensure dotenv has run in index.js before this file is loaded
const ai = new GoogleGenAI({});
const openai = new OpenAI({});

// --- Configuration ---
const GEMINI_MODEL_EXTRACT = "gemini-2.5-flash"; 
const GEMINI_MODEL_GUIDE = "gemini-2.5-pro";    
const CHATGPT_MODEL_EXTRACT = "gpt-4o-mini";    
const CHATGPT_MODEL_GUIDE = "gpt-4o";           


// 1. Define the schema for a single Feature Object
const featureObjectSchema = {
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

// 2. Define the TOP-LEVEL schema for Gemini (which accepts an array)
const geminiExtractionSchema = {
    type: "array",
    items: featureObjectSchema
};

// 3. Define the TOP-LEVEL schema for OpenAI (which requires an object wrapper)
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
                        parameters: openaiExtractionSchema, // Use the new OBJECT schema here
                    }
                }],
                tool_choice: { type: "function", function: { name: "extract_features" } },
                temperature: 0.1,
            });
            
            // The JSON output will be inside the function call arguments
            const callArguments = response.choices[0].message.tool_calls[0].function.arguments;
            jsonText = callArguments; 
            
            // Parse the JSON string and extract the array from the wrapper object
            const parsedObject = JSON.parse(jsonText);
            finalResult = parsedObject.extractedFeatures || [];

        } else { // 'gemini'
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL_EXTRACT,
                contents: prompt,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: geminiExtractionSchema, // Use the array schema here
                    temperature: 0.1,
                },
            });
            jsonText = response.text.trim();
            finalResult = JSON.parse(jsonText); // Gemini returns the array directly
        }

        // Return the final array of features
        return finalResult;

    } catch (error) {
        console.error(`[${provider.toUpperCase()}] API Extraction Error:`, error);
        return [];
    }
}


// ------------------------------------------
// Guide Generation Wrapper
// ------------------------------------------

async function generateGuide(feature, useCase, provider = 'gemini') {
    const guidePrompt = `
        You are a technical writer. Write a comprehensive, step-by-step technical guide for a user.
        The guide should focus on the new Red Hat feature: **${feature.featureName}** (Summary: ${feature.featureSummary}).
        The entire guide must be contextualized around the following real-world scenario/use case: **${useCase}**.
        
        The guide must be returned as a complete HTML snippet (excluding <html>, <head>, and <body> tags, but including <h1>, <p>, <h2>, <ul>, and <code> tags).
        It should be professional, instructive, and include:
        1. An introduction relating the feature to the use case.
        2. Prerequisites (e.g., 'RHEL 9', 'OpenShift Cluster access').
        3. A section of at least 3-10 actionable, technical steps/commands with brief explanations.
        4. A conclusion on the value proposition.
    `;

    try {
        let responseText;

        if (provider === 'openai') {
            const response = await openai.chat.completions.create({
                model: CHATGPT_MODEL_GUIDE,
                messages: [{ role: "user", content: guidePrompt }],
                temperature: 0.7,
            });
            responseText = response.choices[0].message.content;

        } else { // 'gemini'
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL_GUIDE,
                contents: guidePrompt,
                config: { temperature: 0.7 }
            });
            responseText = response.text;
        }

        // Clean up markdown fences if necessary (both sometimes use them)
        return responseText.replace(/```(html)?/g, '').trim();

    } catch (error) {
        console.error(`[${provider.toUpperCase()}] API Guide Generation Error:`, error);
        return "<h3>Error Generating Guide</h3><p>Could not generate the technical guide using the selected AI provider.</p>";
    }
}

module.exports = { extractFeatures, generateGuide };