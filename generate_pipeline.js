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
const QUALITY_LOG = path.join(OUTPUT_DIR, 'quality_warnings.log');

// Ensure output and state directories exist
[INPUT_DIR, OUTPUT_DIR, STATE_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {}

// ── Provider Config ─────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.LLM_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_MODEL = 'qwen/qwen3.8-27b';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-v4-flash-0731:free';
const GEMINI_MODEL = 'gemini-2.5-flash';

let active_provider = process.env.PROVIDER || (OPENROUTER_API_KEY ? 'DeepSeek' : 'Grok');
const disabledProviders = new Set();

// Groq's free tier caps output tokens per minute quite low (observed: 1000 OTPM),
// so calls need real spacing or both providers end up rate-limited back-to-back.
const PACING_MS = parseInt(process.env.PACING_MS || '4000', 10);
const COOLDOWN_MIN_MS = parseInt(process.env.COOLDOWN_MIN_MS || '4000', 10);
const COOLDOWN_MAX_MS = parseInt(process.env.COOLDOWN_MAX_MS || '20000', 10);

const WRITING_DIRECTIONS = [
  {
    id: 'hosting-moment',
    label: 'shared-use moment',
    guidance: 'Begin from the occasion or daily moment this product supports, then connect only the available facts to comfort, utility, and room feel.',
  },
  {
    id: 'material-first',
    label: 'material and finish',
    guidance: 'Lead with material, finish, texture, or craft cues from the data, then show how those facts shape the product experience.',
  },
  {
    id: 'form-function',
    label: 'form and function',
    guidance: 'Start from the product type and what it helps the user do, then fold in construction, storage, seating, or pairing details where present.',
  },
  {
    id: 'room-anchor',
    label: 'room anchor',
    guidance: 'Position the product as part of a room setting, using category and visible facts to describe how it anchors or complements the space.',
  },
  {
    id: 'compact-clarity',
    label: 'compact factual',
    guidance: 'Use a cleaner, direct tone with fewer flourishes, prioritizing specific facts and concise benefits from the product fields.',
  },
  {
    id: 'design-character',
    label: 'design character',
    guidance: 'Lead with silhouette, character, collection mood, or visible style clues in the fields, then move into practical details.',
  },
];

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

function logQualityWarning(productId, productName, category, details) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] QUALITY_ISSUE_KEPT: ID=${productId} | Category=${category} | Name="${productName}" | Details=${JSON.stringify(details)}\n`;
  fs.appendFileSync(QUALITY_LOG, entry, 'utf8');
}

function shortErrorMessage(err) {
  return String(err?.message || err || '').replace(/\s+/g, ' ').slice(0, 700);
}

function rawSnippet(rawText) {
  return String(rawText || '').replace(/\s+/g, ' ').slice(0, 700);
}

// ── Repetition Tracker Management ───────────────────────────────────────────
function createEmptyTrackerState() {
  return {
    opening_lines: [],
    word_frequencies: {},
    restricted_words: [],
    direction_counts: {},
  };
}

function normalizeCategoryKey(category) {
  return String(category || 'uncategorized')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'uncategorized';
}

function loadTracker() {
  if (fs.existsSync(TRACKER_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
      return {
        opening_lines: data.opening_lines || [],
        word_frequencies: data.word_frequencies || {},
        restricted_words: data.restricted_words || [],
        direction_counts: data.direction_counts || {},
        categories: data.categories || {},
      };
    } catch (e) {
      console.warn('Could not parse tracker, initializing fresh state.');
    }
  }
  return {
    ...createEmptyTrackerState(),
    categories: {},
  };
}

function saveTracker(tracker) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2), 'utf8');
}

function getCategoryTracker(tracker, category) {
  tracker.categories = tracker.categories || {};
  const key = normalizeCategoryKey(category);
  const existing = tracker.categories[key] || {};
  tracker.categories[key] = {
    ...createEmptyTrackerState(),
    ...existing,
    category_name: existing.category_name || category,
    opening_lines: existing.opening_lines || [],
    word_frequencies: existing.word_frequencies || {},
    restricted_words: existing.restricted_words || [],
    direction_counts: existing.direction_counts || {},
  };
  return tracker.categories[key];
}

function aggregateCategoryWordFrequencies(tracker) {
  const totals = {};
  for (const categoryTracker of Object.values(tracker.categories || {})) {
    for (const [word, count] of Object.entries(categoryTracker.word_frequencies || {})) {
      totals[word] = (totals[word] || 0) + count;
    }
  }
  return totals;
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

function updateTrackerDirection(tracker, direction) {
  if (!direction || !direction.id) return;
  tracker.direction_counts = tracker.direction_counts || {};
  tracker.direction_counts[direction.id] = (tracker.direction_counts[direction.id] || 0) + 1;
}

function seedCategoryTrackerFromOutput(categoryTracker, outputPath) {
  if (!fs.existsSync(outputPath) || categoryTracker.opening_lines.length > 0) return 0;
  const lines = fs.readFileSync(outputPath, 'utf8').split('\n').filter(Boolean);
  let seeded = 0;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const assistantText = record?.messages?.find((m) => m.role === 'assistant')?.content;
      if (!assistantText) continue;
      updateTrackerWithContent(categoryTracker, extractOpeningLine(assistantText), assistantText);
      seeded++;
    } catch (e) {
      // Keep resume tolerant if one prior JSONL line is malformed.
    }
  }
  return seeded;
}

// ── Word-count enforcement (70-110 words per description) ──────────────────
const MIN_WORDS = 70;
const MAX_WORDS = 110;

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// ── Hard restricted-word check (actually blocks reuse instead of just asking nicely) ──
function findRestrictedWordsUsed(content, restrictedWords) {
  if (!restrictedWords || restrictedWords.length === 0) return [];
  const usedTokens = new Set(tokenizeWords(content));
  return restrictedWords.filter((w) => usedTokens.has(w));
}

// ── Prompt Assembly ─────────────────────────────────────────────────────────
function compactProduct(product, category) {
  const clean = {};
  for (const [key, value] of Object.entries(product || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    clean[key] = value;
  }
  clean.category = clean.category || category;
  return clean;
}

function productSeed(product, category) {
  return JSON.stringify(compactProduct(product, category));
}

function chooseWritingDirection(product, category, tracker, avoidDirectionId = '') {
  const seed = productSeed(product, category);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }

  const counts = tracker.direction_counts || {};
  const candidates = WRITING_DIRECTIONS
    .filter((d) => d.id !== avoidDirectionId)
    .map((d, idx) => ({
      direction: d,
      score: (counts[d.id] || 0) * 10 + Math.abs((hash + idx * 17) % 7),
    }))
    .sort((a, b) => a.score - b.score);

  return (candidates[0] || { direction: WRITING_DIRECTIONS[0] }).direction;
}

function buildPrompt(category, product, repetitionContext, options = {}) {
  if (typeof options === 'string') {
    options = { extraInstruction: options };
  }
  const cleanProduct = compactProduct(product, category);
  const direction = options.direction || WRITING_DIRECTIONS[0];
  const extraInstruction = options.extraInstruction || '';

  const systemPrompt = `You are a product copywriter generating training data for a furniture and home decor brand's fine-tuning dataset.

Write one polished product description in the brand style shown by the examples: warm, design-led, practical, and specific to the product.

TARGET STRUCTURE:
1. Open with a short mood-setting line. It can be a fragment or sentence, but it must feel natural for the product.
2. Introduce the product by name or short name.
3. Bring out key features through storytelling: material, form, finish, storage/seating/use, comfort, or room role, using only available facts.
4. Close by circling back to the product name or the product's role in the home.
5. End with concise bullet points for key facts that are present in the input.

Use this structure as a loose shape, not a repeated template. Vary sentence length, paragraph breaks, opener style, bullet labels, and feature order across products.

STYLE REFERENCES:
- Mood openers can be short, like "Wake up to calm.", "Made for moments that linger.", or "A home for every chapter." Do not copy these exact lines.
- Narrative should feel like the examples: product-first, sensory but factual, and grounded in materials, finish, silhouette, storage, seating, comfort, or display use.
- Bullets should be clean and factual, similar to: "Crafted from solid wood.", "Available in Honey and Danish Walnut finishes.", "Integrated drawer in select variants." Only include bullets supported by INPUT.

WRITING_DIRECTION:
- Current direction: ${direction.id} (${direction.label})
- How to use it: ${direction.guidance}
- This is guidance, not a fixed template. Vary the opening, sentence rhythm, and benefit order naturally.

BOUNDARIES:
- Output must describe only what can be inferred from fields present in INPUT. If description is missing, empty, or thin, work from name, category, material, finish/color, price, warranty, seating/storage, and any other available field.
- Never invent dimensions, measurements, hidden features, collection names, mechanisms, upholstery, seating counts, warranties, or pairings.
- Never mention dimensions, measurements, or sizes (inches/cm/mm), including mattress/table/depth sizes.
- Avoid negative phrasing such as "not suitable for", "avoid", "without", "indoor use only", or similar.
- The full assistant content, including paragraph and bullets, must be between ${MIN_WORDS} and ${MAX_WORDS} words.
- Use one or two short narrative paragraphs plus a compact fact list, but choose the fact-list labels from fields actually present. Skip unknown facts.
- Avoid copying any recent opening line, first 3-4 words, sentence skeleton, or emotional hook from REPETITION_CONTEXT.
- Never use words listed under Restricted words in REPETITION_CONTEXT.

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

class AuthError extends Error {
  constructor(provider, msg) {
    super(msg);
    this.name = 'AuthError';
    this.provider = provider;
  }
}

async function callGrok(prompt) {
  if (!GROQ_API_KEY) {
    throw new AuthError('Grok', 'Missing GROQ_API_KEY or LLM_API_KEY in .env');
  }
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
    if (/tokens per day|TPD|daily/i.test(errText)) {
      throw new AuthError('Grok', `Grok daily token limit reached: ${errText}`);
    }
    const match = errText.match(/(?:try again in|retry in)\s+([\d\.]+)\s*s/i);
    const wait = match ? parseFloat(match[1]) : 8;
    throw new RateLimitError(`Grok HTTP ${response.status}: ${errText}`, wait);
  }

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 401 || response.status === 403 || /invalid api key|unauthorized|forbidden/i.test(errText)) {
      throw new AuthError('Grok', `Grok auth error ${response.status}: ${errText}`);
    }
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

async function callDeepSeek(prompt) {
  if (!OPENROUTER_API_KEY) {
    throw new AuthError('DeepSeek', 'Missing OPENROUTER_API_KEY in .env');
  }
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://localhost',
      'X-Title': 'Product Fine-Tuning Pipeline',
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.75,
      reasoning: { effort: 'none' },
      max_tokens: 600,
    }),
  });

  if (response.status === 429 || response.status === 503) {
    const errText = await response.text();
    const match = errText.match(/(?:try again in|retry in)\s+([\d\.]+)\s*s/i);
    const wait = match ? parseFloat(match[1]) : 8;
    throw new RateLimitError(`DeepSeek HTTP ${response.status}: ${errText}`, wait);
  }

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 401 || response.status === 403 || /invalid api key|unauthorized|forbidden/i.test(errText)) {
      throw new AuthError('DeepSeek', `DeepSeek auth error ${response.status}: ${errText}`);
    }
    if (/rate.?limit|quota|exceeded|too many requests|free.?tier|daily/i.test(errText)) {
      const match = errText.match(/(?:try again in|retry in)\s+([\d\.]+)\s*s/i);
      const wait = match ? parseFloat(match[1]) : 8;
      throw new RateLimitError(`DeepSeek rate limit/quota: ${errText}`, wait);
    }
    throw new Error(`DeepSeek error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('DeepSeek returned empty choices.');
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
    if (
      (/GEMINI_API_KEY|api key|not authenticated|auth/i.test(msg) && !/quota|429|rate.?limit/i.test(msg)) ||
      /TerminalQuotaError|exhausted your daily quota/i.test(msg)
    ) {
      throw new AuthError('Gemini', `Gemini auth error / daily quota exhausted: ${msg}`);
    }
    if (/quota|429|exhausted|rate.?limit|too many requests/i.test(msg)) {
      const match = msg.match(/(?:try again in|retry in)\s+([\d\.]+)\s*s/i);
      const wait = match ? parseFloat(match[1]) : 8;
      throw new RateLimitError(`Gemini rate limit: ${msg}`, wait);
    }
    throw new Error(msg);
  }
}

function getAvailableProviders() {
  const list = [];
  if (OPENROUTER_API_KEY) list.push('DeepSeek');
  if (GROQ_API_KEY) list.push('Grok');
  list.push('Gemini');
  return list;
}

async function executeProviderCall(provider, prompt) {
  const allProviders = getAvailableProviders();
  if (disabledProviders.has(provider)) {
    const usable = allProviders.find((p) => !disabledProviders.has(p));
    if (usable) {
      provider = usable;
    } else {
      throw new AuthError(provider, `${provider} is disabled for this run after an auth/config failure`);
    }
  }
  if (provider === 'DeepSeek') {
    return await callDeepSeek(prompt);
  } else if (provider === 'Grok') {
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

function nextProviderName(provider) {
  const allProviders = getAvailableProviders();
  const usable = allProviders.filter((p) => !disabledProviders.has(p));
  if (usable.length <= 1) return usable[0] || provider;
  const currentIdx = usable.indexOf(provider);
  if (currentIdx === -1) return usable[0];
  return usable[(currentIdx + 1) % usable.length];
}

function hasUsableProvider() {
  return getAvailableProviders().some((p) => !disabledProviders.has(p));
}

// ── Generator Orchestration with Switching ──────────────────────────────────
async function generateForProduct(category, product, tracker, options = {}) {
  const productId = product.uid || product.sku || product.name;
  let attempts = 0;
  const direction = options.direction || chooseWritingDirection(product, category, tracker, options.avoidDirectionId);
  const trigger = options.trigger || 'initial';
  let lastFailureReason = '';

  while (attempts < 4) {
    if (!hasUsableProvider()) {
      const reason = 'No usable providers remain; check GROQ_API_KEY and GEMINI_API_KEY/quota';
      logFailedItem(productId, product.name, category, reason);
      return { success: false, provider: active_provider, direction, trigger, reason };
    }

    attempts++;
    const repetitionContext = getRepetitionContext(tracker);
    const prompt = buildPrompt(category, product, repetitionContext, {
      direction,
      extraInstruction: options.extraInstruction || '',
    });

    let rawOutput = null;
    let providerUsed = active_provider;

    try {
      rawOutput = await executeProviderCall(active_provider, prompt);
    } catch (err) {
      if (err instanceof AuthError) {
        disabledProviders.add(err.provider || active_provider);
        lastFailureReason = shortErrorMessage(err);
        const nextProvider = nextProviderName(active_provider);
        logSwitch(active_provider, nextProvider, lastFailureReason);
        active_provider = nextProvider;
        continue;
      } else if (err instanceof RateLimitError) {
        const nextProvider = nextProviderName(active_provider);
        logSwitch(active_provider, nextProvider, err.message);
        if (activeAnimation) {
          activeAnimation.log(`\n  >> RATE LIMIT on ${active_provider}. Switching to ${nextProvider}...`);
          activeAnimation.setStatus(`Rate limit! Switching to ${nextProvider}...`, nextProvider);
        } else {
          console.log(`\n  >> RATE LIMIT on ${active_provider}. Switching to ${nextProvider}...`);
        }
        active_provider = nextProvider;
        const cooldownMs = Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, Math.ceil((err.waitSecs || 6) * 1000)));
        await new Promise((r) => setTimeout(r, cooldownMs));
        // Retry immediately on new provider
        try {
          rawOutput = await executeProviderCall(active_provider, prompt);
          providerUsed = active_provider;
        } catch (err2) {
          if (err2 instanceof AuthError) {
            disabledProviders.add(err2.provider || active_provider);
            lastFailureReason = shortErrorMessage(err2);
            const fallbackProvider = nextProviderName(active_provider);
            logSwitch(active_provider, fallbackProvider, lastFailureReason);
            active_provider = fallbackProvider;
            continue;
          }
          if (err2 instanceof RateLimitError) {
            logSwitch(active_provider, nextProviderName(active_provider), err2.message);
            logFailedItem(productId, product.name, category, `Both providers failed with rate limits: ${err.message} | ${err2.message}`);
            return { success: false, provider: providerUsed, direction, trigger, reason: 'Both providers rate limited' };
          }
          lastFailureReason = `Provider ${active_provider} failed after rate-limit switch: ${shortErrorMessage(err2)}`;
        }
      } else {
        lastFailureReason = `Provider ${active_provider} error: ${shortErrorMessage(err)}`;
        const nextProvider = nextProviderName(active_provider);
        logSwitch(active_provider, nextProvider, lastFailureReason);
        active_provider = nextProvider;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }

    if (!rawOutput) continue;

    const parsedJson = parseAndValidateChatJson(rawOutput);
    if (!parsedJson) {
      lastFailureReason = `Malformed JSON from ${providerUsed}; raw starts: ${rawSnippet(rawOutput)}`;
      // Malformed JSON: retry once on same provider, if it fails again switch provider
      if (attempts === 1) {
        continue;
      } else {
        const nextProvider = nextProviderName(active_provider);
        logSwitch(active_provider, nextProvider, 'Malformed JSON twice');
        active_provider = nextProvider;
        continue;
      }
    }

    // Success parsing JSON!
    return { success: true, json: parsedJson, provider: providerUsed, direction, trigger };
  }

  const reason = lastFailureReason || 'Exceeded max generation attempts / malformed JSON';
  logFailedItem(productId, product.name, category, reason);
  return { success: false, provider: active_provider, direction, trigger, reason };
}

// ── Terminal Rocket Animation (Pure Node.js, Zero External Deps) ─────────────
let activeAnimation = null;

class RocketAnimation {
  constructor() {
    this.timer = null;
    this.step = 0;
    this.baseTrackLength = 14;
    this.category = '';
    this.index = 0;
    this.total = 0;
    this.provider = '';
    this.productName = '';
    this.statusText = '🚀 Rocket launched!';
    this.isInteractive = Boolean(process.stdout.isTTY);
    this.flames = ['🔥', '✨', '⚡', '💥'];
    this.stars = ['·', ' ', '✦', '·', ' ', '✧', '·', '*'];
    this._onSigInt = () => {
      this.cleanup();
      process.exit(130);
    };
    this._onExit = () => {
      this.cleanup();
    };
  }

  cleanup() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isInteractive) {
      process.stdout.write('\r\x1b[2K\x1b[?25h');
    }
  }

  start({ category, index, total, provider, productName, statusText = '🚀 Rocket launched!' }) {
    this.category = category || '';
    this.index = index || 1;
    this.total = total || 1;
    this.provider = provider || '';
    this.productName = String(productName || '').trim();
    this.statusText = statusText;
    this.step = 0;

    if (!this.isInteractive) {
      console.log(`🚀 [${this.category}] [${this.index}/${this.total}] Launching rocket towards Moon for "${this.productName}"...`);
      return;
    }

    process.removeListener('SIGINT', this._onSigInt);
    process.removeListener('exit', this._onExit);
    process.on('SIGINT', this._onSigInt);
    process.on('exit', this._onExit);

    // Hide cursor for smooth animation
    process.stdout.write('\x1b[?25l');

    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.render();
      this.step++;
    }, 120);
    this.render();
  }

  setStatus(statusText, provider) {
    this.statusText = statusText;
    if (provider) this.provider = provider;
    if (this.isInteractive && this.timer) {
      this.render();
    }
  }

  render() {
    if (!this.isInteractive) return;

    const cols = process.stdout.columns || 80;
    const flame = this.flames[this.step % this.flames.length];
    const trackLen = Math.max(8, Math.min(this.baseTrackLength, Math.floor((cols - 52) / 2)));
    const cycleLength = trackLen + 6;
    const cycleStep = this.step % cycleLength;
    const pos = Math.min(cycleStep, trackLen - 1);

    let trail = '';
    for (let i = 0; i < pos; i++) {
      trail += (i === pos - 1) ? flame : '─';
    }

    let ahead = '';
    for (let i = pos + 1; i < trackLen; i++) {
      const star = this.stars[(i + this.step) % this.stars.length];
      ahead += star;
    }

    const earth = `\x1b[34m🌍\x1b[0m`;
    const moon = `\x1b[33m🌕\x1b[0m`;
    const rocket = `🚀`;

    const tag = `\x1b[36m[${this.category}]\x1b[0m \x1b[33m[${this.index}/${this.total}]\x1b[0m \x1b[35m[${this.provider}]\x1b[0m`;
    const space = `${earth} ${trail}${rocket}${ahead} ${moon}`;

    const rawTagLen = tag.replace(/\x1b\[[0-9;]*m/g, '').length;
    const rawSpaceLen = space.replace(/\x1b\[[0-9;]*m/g, '').length;
    const budget = cols - (rawTagLen + rawSpaceLen + this.statusText.length + 8);
    let prodSnippet = '';
    if (budget > 10 && this.productName) {
      const nameSnippet = this.productName.length > budget ? this.productName.slice(0, budget - 3) + '...' : this.productName;
      prodSnippet = ` \x1b[90m"${nameSnippet}"\x1b[0m`;
    }

    const status = `\x1b[32m${this.statusText}\x1b[0m`;
    const line = `\r\x1b[2K${tag} ${space} ${status}${prodSnippet}`;
    process.stdout.write(line);
  }

  log(msg) {
    if (this.isInteractive) {
      process.stdout.write('\r\x1b[2K');
    }
    console.log(msg);
  }

  stop() {
    this.cleanup();
  }

  succeed({ direction = 'no-direction', trigger = 'initial', customMsg } = {}) {
    this.stop();
    const tag = `\x1b[36m[${this.category}]\x1b[0m \x1b[33m[${this.index}/${this.total}]\x1b[0m \x1b[35m[${this.provider}]\x1b[0m \x1b[94m[${direction}]\x1b[0m \x1b[90m[${trigger}]\x1b[0m \x1b[32m[OK]\x1b[0m`;
    const moonArrival = customMsg || `\x1b[1;33m🌕🚀 Reached the Moon!\x1b[0m 🚩`;
    console.log(`${tag} ${moonArrival}`);
  }

  fail({ direction = 'no-direction', trigger = 'initial', reason = 'FAILED' } = {}) {
    this.stop();
    const tag = `\x1b[36m[${this.category}]\x1b[0m \x1b[33m[${this.index}/${this.total}]\x1b[0m \x1b[35m[${this.provider}]\x1b[0m \x1b[94m[${direction}]\x1b[0m \x1b[90m[${trigger}]\x1b[0m \x1b[31m[FAILED]\x1b[0m`;
    console.log(`${tag} \x1b[31m💥 Mission Aborted: ${reason}\x1b[0m`);
  }
}

async function pacingDelay(ms) {
  if (ms <= 0) return;
  if (!process.stdout.isTTY) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  const start = Date.now();
  while (Date.now() - start < ms) {
    const elapsed = Date.now() - start;
    const remainingSec = Math.max(1, Math.ceil((ms - elapsed) / 1000));
    process.stdout.write(`\r\x1b[2K\x1b[90m⏳ Next rocket fueling in ${remainingSec}s...\x1b[0m`);
    await new Promise((r) => setTimeout(r, 200));
  }
  process.stdout.write('\r\x1b[2K');
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
  let abortPipeline = false;

  // Track initial switch log line count
  let initialSwitchLines = 0;
  if (fs.existsSync(SWITCH_LOG)) {
    initialSwitchLines = fs.readFileSync(SWITCH_LOG, 'utf8').split('\n').filter(Boolean).length;
  }

  const targetCategory = process.env.CATEGORY || process.argv[2];
  let categoryFiles = [
    { file: 'dining.json', category: 'Dining', out: 'dining.jsonl' },
    { file: 'living_room.json', category: 'Living Room', out: 'living_room.jsonl' },
    { file: 'storage.json', category: 'Storage', out: 'storage.jsonl' },
    { file: 'lighting_decor.json', category: 'Lighting & Decor', out: 'lighting_decor.jsonl' },
    { file: 'bedroom.json', category: 'Bedroom', out: 'bedroom.jsonl' },
  ];
  if (targetCategory) {
    categoryFiles = categoryFiles.filter(
      (c) => c.file.includes(targetCategory) || c.out.includes(targetCategory) || c.category.toLowerCase().includes(targetCategory.toLowerCase())
    );
  }

  for (const item of categoryFiles) {
    if (abortPipeline) break;
    const inputPath = path.join(INPUT_DIR, item.file);
    const outputPath = path.join(OUTPUT_DIR, item.out);

    if (!fs.existsSync(inputPath)) {
      console.error(`Input file not found: ${inputPath}`);
      continue;
    }

    const products = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const categoryTracker = getCategoryTracker(tracker, item.category);
    console.log(`\n▶ Processing category: [${item.category}] (${products.length} products) -> ${item.out}`);

    // Check existing lines to support clean resume if rerun
    let existingCount = 0;
    if (fs.existsSync(outputPath)) {
      existingCount = fs.readFileSync(outputPath, 'utf8').split('\n').filter(Boolean).length;
    }
    if (existingCount > 0) {
      console.log(`  (Resuming: ${existingCount} items already processed in ${item.out})`);
      const seededCount = seedCategoryTrackerFromOutput(categoryTracker, outputPath);
      if (seededCount > 0) {
        console.log(`  (Loaded ${seededCount} prior ${item.category} descriptions into category repetition tracker)`);
        saveTracker(tracker);
      }
      totalProcessed += existingCount;
    }

    const rocketAnim = new RocketAnimation();

    for (let i = existingCount; i < products.length; i++) {
      const product = products[i];
      const indexNum = i + 1;
      const productName = product.name || product.title || product.sku || `Item #${indexNum}`;

      activeAnimation = rocketAnim;
      rocketAnim.start({
        category: item.category,
        index: indexNum,
        total: products.length,
        provider: active_provider,
        productName,
        statusText: '🚀 Rocket launched!',
      });

      // 1. First attempt
      let res = await generateForProduct(item.category, product, categoryTracker);

      if (!res.success) {
        totalFailures++;
        rocketAnim.fail({
          direction: res.direction?.id || 'no-direction',
          trigger: res.trigger,
          reason: res.reason || 'FAILED',
        });
        if (/No usable providers remain/i.test(res.reason || '')) {
          console.error(`Stopping early: ${res.reason}`);
          abortPipeline = true;
          break;
        }
        continue;
      }

      // 2. Quality checks: opening-line repetition, word count, restricted-word reuse
      let assistantText = res.json.messages[2].content;
      let openingLine = extractOpeningLine(assistantText);
      const similarPrior = checkOpeningFuzzySimilarity(openingLine, categoryTracker.opening_lines);
      const wc = countWords(assistantText);
      const wordCountBad = wc < MIN_WORDS || wc > MAX_WORDS;
      const restrictedUsed = findRestrictedWordsUsed(assistantText, categoryTracker.restricted_words);

      if (similarPrior || wordCountBad || restrictedUsed.length > 0) {
        const issues = [];
        let retryTrigger = 'quality-retry';
        if (similarPrior) {
          issues.push(`Your previous opening was too similar to: '${similarPrior}'. Generate a structurally different opening this time.`);
          retryTrigger = 'similar-opening';
        }
        if (wordCountBad) {
          issues.push(`Your previous draft was ${wc} words, which is outside the required ${MIN_WORDS}-${MAX_WORDS} word range. Rewrite to land inside that range.`);
          if (retryTrigger === 'quality-retry') retryTrigger = 'word-count';
        }
        if (restrictedUsed.length > 0) {
          issues.push(`Your previous draft reused these overused words: ${restrictedUsed.join(', ')}. Do not use them or close synonyms — pick genuinely different words.`);
          if (retryTrigger === 'quality-retry') retryTrigger = 'restricted-word';
        }
        const retryInstruction = issues.join(' ');
        const retryDirection = chooseWritingDirection(product, item.category, categoryTracker, res.direction?.id);
        const retryProvider = nextProviderName(active_provider);
        logSwitch(active_provider, retryProvider, `Quality retry: ${retryTrigger}; direction ${res.direction?.id || 'unknown'} -> ${retryDirection.id}`);
        rocketAnim.log(`  >> QUALITY RETRY (${retryTrigger}). Switching provider ${active_provider} -> ${retryProvider}; direction ${res.direction?.id || 'unknown'} -> ${retryDirection.id}`);
        rocketAnim.setStatus(`🚀 Booster ignited (${retryTrigger})...`, retryProvider);
        active_provider = retryProvider;
        const retryRes = await generateForProduct(item.category, product, categoryTracker, {
          direction: retryDirection,
          extraInstruction: retryInstruction,
          trigger: retryTrigger,
        });
        if (retryRes.success) {
          const retryWc = countWords(retryRes.json.messages[2].content);
          const retryRestricted = findRestrictedWordsUsed(retryRes.json.messages[2].content, categoryTracker.restricted_words);
          const retrySimilar = checkOpeningFuzzySimilarity(extractOpeningLine(retryRes.json.messages[2].content), categoryTracker.opening_lines);
          // Only accept the retry if it's a genuine improvement; otherwise keep original
          if (retryWc >= MIN_WORDS && retryWc <= MAX_WORDS && retryRestricted.length <= restrictedUsed.length && !retrySimilar) {
            res = retryRes;
            assistantText = res.json.messages[2].content;
            openingLine = extractOpeningLine(assistantText);
          } else {
            // Log persistent quality issue so it's visible without failing the item
            const qProductId = product.uid || product.sku || product.name;
            logQualityWarning(qProductId, product.name, item.category, {
              wordCount: wordCountBad ? wc : null,
              retryWordCount: retryWc,
              restrictedUsed,
              retryRestricted,
              similarPrior,
              retrySimilar,
              originalDirection: res.direction?.id,
              retryDirection: retryRes.direction?.id,
            });
          }
        }
      }

      // 3. Update tracker & persist
      updateTrackerWithContent(categoryTracker, openingLine, assistantText);
      updateTrackerDirection(categoryTracker, res.direction);
      saveTracker(tracker);

      // 4. Append final valid JSON object as one line
      fs.appendFileSync(outputPath, JSON.stringify(res.json) + '\n', 'utf8');

      totalProcessed++;
      rocketAnim.succeed({
        direction: res.direction?.id || 'no-direction',
        trigger: res.trigger,
      });

      // Pacing delay between calls (configurable via PACING_MS; Groq's low OTPM cap needs real spacing)
      await pacingDelay(PACING_MS);
    }
    rocketAnim.stop();
    activeAnimation = null;
  }

  // Count total provider switches recorded during this session
  let finalSwitchLines = 0;
  if (fs.existsSync(SWITCH_LOG)) {
    finalSwitchLines = fs.readFileSync(SWITCH_LOG, 'utf8').split('\n').filter(Boolean).length;
  }
  totalSwitches = Math.max(0, finalSwitchLines - initialSwitchLines);

  // Top 10 most-used words
  const categoryWordFrequencies = aggregateCategoryWordFrequencies(tracker);
  const summaryWordFrequencies = Object.keys(categoryWordFrequencies).length > 0
    ? categoryWordFrequencies
    : tracker.word_frequencies;
  const sortedWords = Object.entries(summaryWordFrequencies)
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
  generateForProduct,
  checkOpeningFuzzySimilarity,
  extractOpeningLine,
  tokenizeWords,
  buildPrompt,
  chooseWritingDirection,
  compactProduct,
  parseAndValidateChatJson,
  countWords,
  findRestrictedWordsUsed,
  RocketAnimation,
  pacingDelay,
  MIN_WORDS,
  MAX_WORDS,
};
