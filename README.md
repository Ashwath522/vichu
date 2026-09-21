# vichu

Generates OpenAI fine-tuning-format (`messages` chat JSONL) product descriptions for
furniture/home-decor product data, using Groq and Gemini as interchangeable providers
with automatic failover between them.

## What it does

For each product in `input/{dining,living_room,storage,lighting_decor,bedroom}.json`, it:

1. Builds a flexible prompt from product fields plus a named writing direction
   (`hosting-moment`, `material-first`, `form-function`, etc.) and the current
   repetition context (recently used opening lines + overused words).
2. Calls the active provider (Grok via Groq API, or Gemini via the `gemini` CLI).
   On a rate limit it switches providers and retries the same item immediately.
3. Validates the response is well-formed OpenAI chat JSON.
4. Checks output quality: opening line isn't too similar to a recent one, word count
   is within **70-110 words**, and no "restricted" (overused) word was reused. If any
   check fails, it regenerates once with an explicit correction instruction, switches
   provider, and changes writing direction. If the retry still doesn't pass, the
   original item is kept and the issue is logged to `output/quality_warnings.log`
   (the item is never dropped).
5. Appends the result to `output/{category}.jsonl` and updates `state/repetition_tracker.json`.

Progress resumes automatically: re-running the script skips categories/items already
present in `output/*.jsonl`.

The prompt is intentionally loose-coupled: missing descriptions are allowed, sparse
products still generate from whatever fields exist, and the directions guide variety
without forcing every item into the same sentence template. Console logs show:

```text
[Dining] [12/120] [Grok] [material-first] [initial] [OK]
```

That means category/item, provider, writing direction, retry trigger, and status.

## Setup

```bash
npm install dotenv   # only real dependency; fetch/execSync are built-in
```

Create a `.env` file (gitignored) with:

```
GROQ_API_KEY=your_groq_key_here
```

Gemini is called via the `gemini` CLI, so it must be installed and authenticated
separately (`npm install -g @google/gemini-cli` or similar, then `gemini` should
run without prompting).

## Run

```bash
node generate_pipeline.js
```

Optional tuning via env vars (Groq's free tier has a low output-tokens-per-minute
cap, so these exist to avoid constant rate-limit thrashing):

- `PACING_MS` (default `4000`) — delay between successful calls
- `COOLDOWN_MIN_MS` / `COOLDOWN_MAX_MS` (default `4000` / `20000`) — backoff range
  after a rate-limit response

## Output

- `output/{category}.jsonl` — one OpenAI fine-tuning chat-format object per line
- `output/failed_items.log` — items that failed generation entirely (both providers
  rate-limited, or malformed JSON after retries)
- `output/quality_warnings.log` — items kept despite failing a quality check
  (word count / repeated opening / reused restricted word) after one retry
- `output/provider_switch.log` — every Grok↔Gemini failover, with reason
- `state/repetition_tracker.json` — persists across runs: opening lines used so far,
  word frequency counts, writing direction counts, and the current restricted-word
  list (words used 5+ times)

## Notes

- All five product categories (dining, living room, storage, lighting & decor,
  and bedroom) are wired into the pipeline with inputs located in `input/`.
