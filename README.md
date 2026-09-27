# TrendScript 📈🎬

TrendScript turns real-time search data into ready-to-film, 30-second YouTube Shorts production packages. It pulls breakout queries for your niche from Google Trends, uses Groq's fast LLaMA models to shape them into hook-driven topics, then writes a complete package: title, opening shot, caption, hashtags, a timed four-phase script and timeline chapters.

## ✨ Features

- **Live trend discovery**: related "rising" queries from Google Trends for any niche, with an optional region filter.
- **Graceful fallbacks**: if Google Trends rate-limits the server (common from cloud IPs), TrendScript falls back to live Google search suggestions, then to niche-based seeds, and tells you which source was used. It never just fails.
- **AI topic generation**: six specific, curiosity-driven Shorts topics from the raw keywords, or script your own topic.
- **Complete production packages**:
  - High-CTR title and a thumbnail / opening-shot concept
  - Caption and hashtags (always including `#shorts`)
  - A 4-phase script (Hook 0–3s, Build-up 3–15s, Climax 15–25s, CTA 25–30s) written to a ~75-word budget
  - Timeline chapters
- **Script tone**: energetic, educational, storytelling or humorous.
- **Runtime estimate**: per-section and total spoken-time estimates (at 150 wpm) so you know the script actually fits 30 seconds.
- **Export**: copy the script, the title, caption + hashtags or the whole package, or download it as Markdown.
- **Saved packages**: the last 25 packages are kept in your browser, so reopening one is instant and costs no API calls.
- **Hardened by default**: validated and normalized AI output, HTML-safe rendering, strict Content-Security-Policy, input limits, per-IP rate limiting and request timeouts.

## 🚀 Tech Stack

- **Frontend**: HTML, CSS, vanilla JavaScript (`index.html`, `style.css`, `app.js`), no build step
- **Backend**: Vercel Serverless Functions (`api/trends.js`, `api/generate.js`) sharing code in `lib/`
- **AI**: [Groq](https://console.groq.com/) (`llama-3.1-8b-instant` by default, configurable)
- **Data**: [`google-trends-api`](https://www.npmjs.com/package/google-trends-api) and Google search suggestions
- **Tests**: Node's built-in test runner, no extra dependencies

## 🛠️ Setup

### Prerequisites

- Node.js 20 or newer
- A free [Groq Cloud](https://console.groq.com/keys) API key

### 1. Clone and install

```bash
git clone https://github.com/rameshkumark24/trendscript.git
cd trendscript
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Then set your key in `.env`:

```env
GROQ_API_KEY=your_groq_api_key_here
```

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GROQ_API_KEY` | Yes | | Your Groq API key. |
| `GROQ_MODEL` | No | `llama-3.1-8b-instant` | Any Groq chat model that supports JSON mode. If the model is retired, the server automatically switches to one your key can use. |
| `RATE_LIMIT_PER_MINUTE` | No | `20` | Max API requests per client IP per minute, per server instance. `0` disables it. |

### 3. Run locally

```bash
npm run dev
```

Open <http://localhost:3000>. This small built-in server serves the frontend and runs the same `/api` handlers that Vercel does, with the same security headers.

**No API key yet, or working offline?** Run the fully simulated mode:

```bash
npm run dev:mock
```

It replaces Google and Groq with realistic canned responses. In mock mode you can include `trends-down` in a niche to see the search-suggestion fallback, or `ratelimit` in a niche or topic to see rate-limit handling.

You can also use the Vercel CLI (`npm i -g vercel && vercel dev`), which reads `.env` too.

### 4. Run the tests

```bash
npm test
```

## ☁️ Deploy to Vercel

1. Import the repository in Vercel (the "Other" framework preset works; no build command is needed).
2. Add `GROQ_API_KEY` (and optionally `GROQ_MODEL`) under **Settings → Environment Variables**, enabled for both **Production** and **Preview**.
3. Deploy. `vercel.json` configures the function timeout and security headers.

> Changing an environment variable only takes effect after a **redeploy**. Every deployment keeps its own `trendscript-xxxx.vercel.app` URL forever, so test the latest deployment or your production domain, not an old link.

> The `/api` routes are Vercel Serverless Functions, so static-only hosts such as Firebase Hosting or GitHub Pages can't run TrendScript without a separate backend.

## 🩺 Troubleshooting

| Message in the app | What it means / how to fix it |
| --- | --- |
| `The server is missing GROQ_API_KEY` | The variable isn't set for this environment. Add it in Vercel (Production **and** Preview), then redeploy. |
| `The AI service rejected the API key` | Groq refused the key: it's mistyped, deleted or revoked. Create a new one at [console.groq.com/keys](https://console.groq.com/keys), update it in Vercel, and redeploy. |
| `The AI service rejected the request. Groq says: "…"` | Groq accepted the key but refused the request; the quoted text is Groq's reason (for example an account restriction). |
| `The AI model "…" is unavailable` | The model is retired and no replacement could be found for your key. Set `GROQ_MODEL` to a model listed in your Groq console. |
| `The AI service is rate limited` | You've hit Groq's rate limit (common on the free tier). Wait a minute and try again. |

## 💡 How to Use

1. **Define your niche**: enter a broad topic (e.g. "Tech Reviews", "Fitness", "React Development"), and optionally pick a region and script tone.
2. **Select a trend**: pick one of the six generated topics, or type your own topic.
3. **Film it**: review the package, check the runtime estimate, then copy or download what you need. Use **Regenerate** for a fresh take.

## 🔌 API

Both endpoints accept `POST` with a JSON body and return JSON. Errors look like `{ "error": "Human-readable message", "code": "machine_code" }`.

**`POST /api/trends`**

```json
{ "category": "Fitness", "region": "US" }
```

```json
{
  "trends": ["When exactly should you take creatine?", "..."],
  "source": "google-trends-rising",
  "keywords": ["creatine timing", "..."]
}
```

`source` is one of `google-trends-rising`, `google-trends-top`, `google-autocomplete` or `fallback`.

**`POST /api/generate`**

```json
{ "topic": "When exactly should you take creatine?", "niche": "Fitness", "tone": "educational" }
```

```json
{
  "package": {
    "title": "...",
    "thumbnail_idea": "...",
    "caption": "...",
    "hashtags": ["#creatine", "#fitness", "#shorts"],
    "chapters": [{ "time": "0:00", "label": "The Hook" }],
    "script": { "hook": "...", "buildup": "...", "climax": "...", "cta": "..." }
  },
  "tone": "educational"
}
```

## 📂 Project Structure

```text
├── api/
│   ├── generate.js         # POST /api/generate: production package
│   └── trends.js           # POST /api/trends: trend discovery + AI topics
├── lib/
│   ├── errors.js           # HttpError / AiOutputError
│   ├── groq.js             # Groq client: timeouts, retries, error mapping
│   ├── http.js             # JSON request/response helpers
│   ├── input.js            # Input sanitizing helpers
│   ├── normalize.js        # Validates and normalizes AI output
│   ├── options.js          # Supported regions and tones
│   ├── prompts.js          # System prompts
│   ├── rate-limit.js       # Per-IP rate limiter
│   └── trend-sources.js    # Google Trends -> suggestions -> fallback seeds
├── dev/
│   ├── server.js           # Local dev server (npm run dev)
│   └── mock-upstreams.js   # Offline Google/Groq stand-ins (npm run dev:mock, tests)
├── test/                   # node:test suites
├── index.html              # App UI
├── app.js                  # Frontend logic
├── style.css               # Styles
├── 404.html                # Not-found page
├── favicon.svg
├── vercel.json             # Function config + security headers
└── .env.example
```

## 📝 License

This project is open-source and available under the [MIT License](LICENSE).
