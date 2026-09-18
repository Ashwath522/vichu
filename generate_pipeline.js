'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Unbuffer stdout if writing to pipe/file
if (process.stdout._handle && process.stdout._handle.setBlocking) {
  process.stdout._handle.setBlocking(true);
}

// ── Paths ───────────────────────────────────────────────────────────────────
const BASE_DIR = __dirname;
const INPUT_DIR = path.join(BASE_DIR, 'input');
const OUTPUT_DIR = path.join(BASE_DIR, 'output');
const STATE_DIR = path.join(BASE_DIR, 'state');

const TRACKER_FILE = path.join(STATE_DIR, 'repetition_tracker.json');
const SWITCH_LOG = path.join(OUTPUT_DIR, 'provider_switch.log');
const FAILED_LOG = path.join(OUTPUT_DIR, 'failed_items.log');

// Ensure output and state directories exist
[INPUT_DIR, OUTPUT_DIR, STATE_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {}

// ── Provider Config ─────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.LLM_API_KEY;
const GROQ_MODEL = 'qwen/qwen3.8-27b';
const GEMINI_MODEL = 'gemini-2.5-flash';

let active_provider = 'Grok'; // Starts with Grok as requested

// ── Stopwords (Common English function words & bullet labels) ───────────────
const STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'with', 'for', 'to', 'of',
  'and', 'in', 'on', 'is', 'it', 'its', 'are', 'be', 'as', 'at', 'by', 'we',
  'you', 'your', 'our', 'has', 'have', 'had', 'was', 'were', 'will', 'would',
  'can', 'could', 'from', 'or', 'so', 'if', 'then', 'into', 'each', 'all',
  'both', 'such', 'no', 'not', 'only', 'more', 'most', 'other', 'some', 'than',
  'too', 'very', 'just', 'but', 'material', 'materials', 'finish', 'finishes',
  'capacity', 'storage', 'warranty', 'pairing', 'color', 'colour', 'price',
  'category', 'subcategory', 'bullet', 'primary', 'secondary', 'type', 'key',
  'facts', 'options', 'months', 'year', 'years', 'rs', 'inr', 'piece', 'space'
]);

// ── Logging Helpers ─────────────────────────────────────────────────────────
function logSwitch(fromProvider, toProvider, reason) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] SWITCH: ${fromProvider} -> ${toProvider} (Reason: ${reason})\n`;
  fs.appendFileSync(SWITCH_LOG, entry, 'utf8');
}

function logFailedItem(productId, productName, category, reason) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] FAILED: ID=${productId} | Category=${category} | Name="${productName}" | Reason=${reason}\n`;
  fs.appendFileSync(FAILED_LOG, entry, 'utf8');
}

// ── Repetition Tracker Management ───────────────────────────────────────────
function loadTracker() {
  if (fs.existsSync(TRACKER_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
      return {
        opening_lines: data.opening_lines || [],
        word_frequencies: data.word_frequencies || {},
        restricted_words: data.restricted_words || [],
      };
    } catch (e) {
      console.warn('Could not parse tracker, initializing fresh state.');
    }
  }
  return {
    opening_lines: [],
    word_frequencies: {},
    restricted_words: [],
  };
}

function saveTracker(tracker) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2), 'utf8');
}

function getRepetitionContext(tracker) {
  const recentOpeners = tracker.opening_lines.slice(-20);
  const restrictedWords = tracker.restricted_words.slice(-30);

  let context = '';
  if (recentOpeners.length > 0) {
    context += `Recent opening lines used (DO NOT copy their phrasing, emotion hook, or first 4 words):\n` +
      recentOpeners.map((line, i) => `  ${i + 1}. "${line}"`).join('\n') + '\n\n';
  } else {
    context += `Recent opening lines: None yet.\n\n`;
  }

  if (restrictedWords.length > 0) {
    context += `Restricted words (frequency limit reached, DO NOT use these words):\n  ${restrictedWords.join(', ')}\n`;
  } else {
    context += `Restricted words: None yet.\n`;
  }

  return context.trim();
}

// ── Text Analysis & Repetition Check ────────────────────────────────────────
function extractOpeningLine(assistantText) {
  if (!assistantText) return '';
  const narrative = assistantText.split(/\n\n|•|-/)[0].trim();
  const sentences = narrative.split(/(?<=[.!?])\s+/);
  return (sentences[0] || narrative).replace(/\n+/g, ' ').trim();
}

function tokenizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function checkOpeningFuzzySimilarity(newOpening, priorOpenings) {
  const newTokens = tokenizeWords(newOpening).slice(0, 5);
  if (newTokens.length === 0) return null;

  for (const prior of priorOpenings) {
    const priorTokens = tokenizeWords(prior).slice(0, 5);
    if (priorTokens.length === 0) continue;

    // 1. Check if first 3 words match exactly
    if (
      newTokens.length >= 3 &&
      priorTokens.length >= 3 &&
      newTokens[0] === priorTokens[0] &&
      newTokens[1] === priorTokens[1] &&
      newTokens[2] === priorTokens[2]
    ) {
      return prior;
    }

    // 2. Jaccard overlap on first 5 words
    const setA = new Set(newTokens);
    const setB = new Set(priorTokens);
    let intersection = 0;
    for (const t of setA) {
      if (setB.has(t)) intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    if (union > 0 && intersection / union >= 0.6) {
      return prior;
    }
  }

  return null;
}

function updateTrackerWithContent(tracker, openingLine, fullContent) {
  tracker.opening_lines.push(openingLine);

  const tokens = tokenizeWords(fullContent);
  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue;
    tracker.word_frequencies[token] = (tracker.word_frequencies[token] || 0) + 1;
    if (tracker.word_frequencies[token] >= 5 && !tracker.restricted_words.includes(token)) {
      tracker.restricted_words.push(token);
    }
  }
}

// ── Prompt Assembly ─────────────────────────────────────────────────────────
function buildPrompt(category, product, repetitionContext, extraInstruction = '') {
  const cleanProduct = {
    name: product.name,
    product_short_name: product.product_short_name,
    category: product.category || category,
    subcategory: product.subcategory,
    price: product.price,
    primary_material: product.primary_material,
    secondary_material: product.secondary_material,
    color_finish: product.color_finish,
    seating_capacity: product.seating_capacity,
    storage_type: product.storage_type,
    warranty_months: product.warranty_months,
    description: product.description,
  };

  const systemPrompt = `You are a product copywriter generating training data for a furniture and home decor brand's fine-tuning dataset. Write one marketing description per product using this structure:

[Mood-setting opening line] + [Introduce the product] + [Storytelling through features] + [Close circling back to product name] + [Bullet list of key facts]

RULES:
- Opening line must be a distinct mood/emotion line — never reuse a sentence pattern or opening phrase already used elsewhere in this session (a running list of prior openings will be provided as REPETITION_CONTEXT — avoid matching their structure or first 3-4 words).
- No single word or phrase may repeat more than 5-6 times across the full dataset. If REPETITION_CONTEXT shows a word is near its limit, actively avoid it and use a synonym.
- NEVER mention dimensions, measurements, or sizes (inches/cm/mm), including mattress/table/depth sizes.
- NEVER use negative phrasing (no "not suitable for," "avoid," "without," "indoor use only," etc.) — state only what the product positively offers.
- Do not invent facts — use only fields present in the input JSON.
- Paragraph: 3-5 sentences. Bullets: material, finish/color options, capacity/storage type, warranty, pairing info — only from given fields.
- Word limit is 70-110 .
INPUT: One product JSON object (category: ${category}).
${JSON.stringify(cleanProduct, null, 2)}

REPETITION_CONTEXT:
${repetitionContext}
${extraInstruction ? `\nSPECIAL INSTRUCTION: ${extraInstruction}\n` : ''}
OUTPUT: Return ONLY a valid JSON object in this exact OpenAI fine-tuning chat format, nothing else, no markdown fences:

{
  "messages": [
    {"role": "system", "content": "You are a product copywriter for a furniture and home decor brand."},
    {"role": "user", "content": "Write a product description for: {compact product summary — name, category, material, finish, price}"},
    {"role": "assistant", "content": "{full generated description: narrative paragraph + bullet list, as one string with \\n line breaks}"}
  ]
}`;

  return systemPrompt;
}

// ── Provider Execution ──────────────────────────────────────────────────────
class RateLimitError extends Error {
  constructor(msg, waitSecs = 8) {
    super(msg);
    this.name = 'RateLimitError';
    this.waitSecs = waitSecs;
  }
}

async function callGrok(prompt) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.75,
      max_tokens: 350,
    }),
  });

  if (response.status === 429 || response.status === 503) {
    const errText = await response.text();
    const match = errText.match(/(?:try again in|retry in)\s+([\d\.]+)\s*s/i);
    const wait = match ? parseFloat(match[1]) : 8;
    throw new RateLimitError(`Grok HTTP ${response.status}: ${errText}`, wait);
  }

  if (!response.ok) {
    const errText = await response.text();
    if (/rate.?limit|quota|exceeded|too many requests/i.test(errText)) {
      const match = errText.match(/(?:try again in|retry in)\s+([\d\.]+)\s*s/i);
      const wait = match ? parseFloat(match[1]) : 8;
      throw new RateLimitError(`Grok rate limit message: ${errText}`, wait);
    }
    throw new Error(`Grok error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Grok returned empty choices.');
  return text;
}

function callGemini(prompt) {
  try {
    const stdout = execSync(`gemini -m ${GEMINI_MODEL} --skip-trust -p ""`, {
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 35000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!stdout || !stdout.trim()) {
      throw new Error('Gemini returned empty stdout.');
    }
    return stdout;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const msg = `${err.message || ''} ${stderr}`.trim();
    if (/quota|429|exhausted|rate.?limit|too many requests/i.test(msg)) {
      const match = msg.match(/(?:try again in|retry in)\s+([\d\.]+)\s*s/i);
      const wait = match ? parseFloat(match[1]) : 8;
      throw new RateLimitError(`Gemini rate limit: ${msg}`, wait);
    }
    throw new Error(msg);
  }
}

async function executeProviderCall(provider, prompt) {
  if (provider === 'Grok') {
    return await callGrok(prompt);
  } else {
    return callGemini(prompt);
  }
}

function parseAndValidateChatJson(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // If there are leading/trailing characters around the outer json object
  const startIdx = cleaned.indexOf('{');
  const endIdx = cleaned.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length < 3) {
      return null;
    }
    const [sys, usr, ast] = parsed.messages;
    if (sys.role !== 'system' || usr.role !== 'user' || ast.role !== 'assistant') {
      return null;
    }
    if (typeof ast.content !== 'string' || ast.content.trim().length < 20) {
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

// ── Generator Orchestration with Switching ──────────────────────────────────
async function generateForProduct(category, product, tracker, extraInstruction = '') {
  const productId = product.uid || product.sku || product.name;
  let attempts = 0;

  while (attempts < 4) {
    attempts++;
    const repetitionContext = getRepetitionContext(tracker);
    const prompt = buildPrompt(category, product, repetitionContext, extraInstruction);

    let rawOutput = null;
    let providerUsed = active_provider;

    try {
      rawOutput = await executeProviderCall(active_provider, prompt);
    } catch (err) {
      if (err instanceof RateLimitError) {
        const nextProvider = active_provider === 'Grok' ? 'Gemini' : 'Grok';
        logSwitch(active_provider, nextProvider, err.message);
        console.log(`\n  >> RATE LIMIT on ${active_provider}. Switching to ${nextProvider}...`);
        active_provider = nextProvider;
        const cooldownMs = Math.min(15000, Math.max(3000, Math.ceil((err.waitSecs || 6) * 1000)));
        await new Promise((r) => setTimeout(r, cooldownMs));
        // Retry immediately on new provider
        try {
          rawOutput = await executeProviderCall(active_provider, prompt);
          providerUsed = active_provider;
        } catch (err2) {
          if (err2 instanceof RateLimitError) {
            logSwitch(active_provider, active_provider === 'Grok' ? 'Gemini' : 'Grok', err2.message);
            logFailedItem(productId, product.name, category, `Both providers failed with rate limits: ${err.message} | ${err2.message}`);
            return { success: false, provider: providerUsed, reason: 'Both providers rate limited' };
          }
        }
      } else {
        // General error, retry once
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }

    if (!rawOutput) continue;

    const parsedJson = parseAndValidateChatJson(rawOutput);
    if (!parsedJson) {
      // Malformed JSON: retry once on same provider, if it fails again switch provider
      if (attempts === 1) {
        continue;
      } else {
        const nextProvider = active_provider === 'Grok' ? 'Gemini' : 'Grok';
        logSwitch(active_provider, nextProvider, 'Malformed JSON twice');
        active_provider = nextProvider;
        continue;
      }
    }

    // Success parsing JSON!
    return { success: true, json: parsedJson, provider: providerUsed };
  }

  logFailedItem(productId, product.name, category, 'Exceeded max generation attempts / malformed JSON');
  return { success: false, provider: active_provider, reason: 'Exceeded max attempts' };
}

// ── Main Pipeline Execution ─────────────────────────────────────────────────
async function runPipeline() {
  console.log('===============================================================');
  console.log('STARTING DATA-GENERATION PIPELINE');
  console.log(`Initial active provider: ${active_provider}`);
  console.log(`Input Directory:  ${INPUT_DIR}`);
  console.log(`Output Directory: ${OUTPUT_DIR}`);
  console.log(`State Directory:  ${STATE_DIR}`);
  console.log('===============================================================\n');

  const tracker = loadTracker();
  let totalProcessed = 0;
  let totalFailures = 0;
  let totalSwitches = 0;

  // Track initial switch log line count
  let initialSwitchLines = 0;
  if (fs.existsSync(SWITCH_LOG)) {
    initialSwitchLines = fs.readFileSync(SWITCH_LOG, 'utf8').split('\n').filter(Boolean).length;
  }

  const categoryFiles = [
    { file: 'dining.json', category: 'Dining', out: 'dining.jsonl' },
    { file: 'living_room.json', category: 'Living Room', out: 'living_room.jsonl' },
    { file: 'storage.json', category: 'Storage', out: 'storage.jsonl' },
    { file: 'lighting_decor.json', category: 'Lighting & Decor', out: 'lighting_decor.jsonl' },
  ];

  for (const item of categoryFiles) {
    const inputPath = path.join(INPUT_DIR, item.file);
    const outputPath = path.join(OUTPUT_DIR, item.out);

    if (!fs.existsSync(inputPath)) {
      console.error(`Input file not found: ${inputPath}`);
      continue;
    }

    const products = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    console.log(`\n▶ Processing category: [${item.category}] (${products.length} products) -> ${item.out}`);

    // Check existing lines to support clean resume if rerun
    let existingCount = 0;
    if (fs.existsSync(outputPath)) {
      existingCount = fs.readFileSync(outputPath, 'utf8').split('\n').filter(Boolean).length;
    }
    if (existingCount > 0) {
      console.log(`  (Resuming: ${existingCount} items already processed in ${item.out})`);
      totalProcessed += existingCount;
    }

    for (let i = existingCount; i < products.length; i++) {
      const product = products[i];
      const indexNum = i + 1;

      // 1. First attempt
      let res = await generateForProduct(item.category, product, tracker);

      if (!res.success) {
        totalFailures++;
        console.log(`[${item.category}] [${indexNum}/${products.length}] [${res.provider}] [FAILED]`);
        continue;
      }

      // 2. Repetition check on opening line
      let assistantText = res.json.messages[2].content;
      let openingLine = extractOpeningLine(assistantText);
      const similarPrior = checkOpeningFuzzySimilarity(openingLine, tracker.opening_lines);

      if (similarPrior) {
        // Regenerate the SAME product once more with explicit instruction appended
        const retryInstruction = `Your previous opening was too similar to: '${similarPrior}'. Generate a structurally different opening this time.`;
        const retryRes = await generateForProduct(item.category, product, tracker, retryInstruction);
        if (retryRes.success) {
          res = retryRes;
          assistantText = res.json.messages[2].content;
          openingLine = extractOpeningLine(assistantText);
        }
      }

      // 3. Update tracker & persist
      updateTrackerWithContent(tracker, openingLine, assistantText);
      saveTracker(tracker);

      // 4. Append final valid JSON object as one line
      fs.appendFileSync(outputPath, JSON.stringify(res.json) + '\n', 'utf8');

      totalProcessed++;
      console.log(`[${item.category}] [${indexNum}/${products.length}] [${res.provider}] [OK]`);

      // Pacing delay between calls (2000ms for stable token replenishment)
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Count total provider switches recorded during this session
  let finalSwitchLines = 0;
  if (fs.existsSync(SWITCH_LOG)) {
    finalSwitchLines = fs.readFileSync(SWITCH_LOG, 'utf8').split('\n').filter(Boolean).length;
  }
  totalSwitches = Math.max(0, finalSwitchLines - initialSwitchLines);

  // Top 10 most-used words
  const sortedWords = Object.entries(tracker.word_frequencies)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log('\n===============================================================');
  console.log('DATA-GENERATION PIPELINE RUN COMPLETED');
  console.log('===============================================================');
  console.log(`Total Products Processed: ${totalProcessed}`);
  console.log(`Total Failures:           ${totalFailures}`);
  console.log(`Provider Switch Count:    ${totalSwitches}`);
  console.log('\nTop 10 Most-Used Words:');
  sortedWords.forEach(([w, count], idx) => {
    console.log(`  ${idx + 1}. "${w}": ${count} occurrences`);
  });
  console.log('\nOutput Files:');
  categoryFiles.forEach((cf) => {
    const p = path.join(OUTPUT_DIR, cf.out);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    console.log(`  - ${p} (${size} bytes)`);
  });
  console.log(`  - Tracker: ${TRACKER_FILE}`);
  console.log(`  - Switches: ${SWITCH_LOG}`);
  console.log(`  - Failures: ${FAILED_LOG}`);
  console.log('===============================================================\n');
}

if (require.main === module) {
  runPipeline().catch((err) => {
    console.error('Fatal Pipeline Error:', err);
    process.exit(1);
  });
}

module.exports = {
  runPipeline,
  checkOpeningFuzzySimilarity,
  extractOpeningLine,
  tokenizeWords,
  buildPrompt,
  parseAndValidateChatJson,
};
