# vichu

Generates OpenAI fine-tuning-format (`messages` chat JSONL) product descriptions for
furniture/home-decor product data, using Groq and Gemini as interchangeable providers
with automatic failover between them.

## What it does

For each product in `input/{dining,living_room,storage,lighting_decor}.json`, it:

1. Builds a prompt (mood-opener → intro → storytelling → close → bullets) with the
   current repetition context (recently used opening lines + overused words).
2. Calls the active provider (Grok via Groq API, or Gemini via the `gemini` CLI).
   On a rate limit it switches providers and retries the same item immediately.
3. Validates the response is well-formed OpenAI chat JSON.
4. Checks output quality: opening line isn't too similar to a recent one, word count
   is within **70-110 words**, and no "restricted" (overused) word was reused. If any
   check fails, it regenerates once with an explicit correction instruction. If the
   retry still doesn't pass, the original item is kept and the issue is logged to
   `output/quality_warnings.log` (the item is never dropped).
5. Appends the result to `output/{category}.jsonl` and updates `state/repetition_tracker.json`.

Progress resumes automatically: re-running the script skips categories/items already
present in `output/*.jsonl`.

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
  word frequency counts, and the current restricted-word list (words used 5+ times)

## Notes

- `bedroom.json` at the repo root isn't wired into the pipeline (only dining,
  living_room, storage, and lighting_decor are processed). Add it to the
  `categoryFiles` list in `generate_pipeline.js` if you want it included.
