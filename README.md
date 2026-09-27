# TrendScript 📈🎬

TrendScript is a data-driven web app that turns real-time Google Trends data into ready-to-publish, 30-second YouTube Shorts production packages. It pulls rising search queries for your niche, uses Groq's fast LLaMA 3.1 model to turn them into hook-driven topics, then generates a fully timed script with metadata in seconds.

## ✨ Features

- **Real-time trend discovery**: Pulls rising and top related queries from Google Trends for any niche. If Google rate-limits the request, the app falls back to niche-based keywords instead of failing.
- **AI topic generation**: Turns raw search keywords into 6 specific, clickable video topics.
- **Complete production packages**:
  - High-CTR video title
  - Visual/thumbnail concept for the opening shot
  - SEO caption and hashtags
  - A strictly timed 4-phase script (Hook, Build-up, Climax, CTA)
  - Timed YouTube chapters
  - Word count with an estimated read time, flagged when the script runs past 30 seconds
- **Export**: Copy the voiceover script, copy the full package as Markdown, or download it as a `.md` file.
- **Smart caching**: Generated packages are cached in `localStorage` (the 25 most recent are kept) for instant reloads. **Regenerate** always fetches a fresh package.
- **Hardened by default**: AI output is rendered as text, never as HTML, which prevents XSS. The server validates input and normalizes the model's JSON before sending it on. Requests time out, and rate-limit errors are shown to the user.
- **Modern, accessible UI**: Responsive dark theme, keyboard-friendly (press Enter to search), live regions for screen readers, and support for reduced-motion settings.

## 🚀 Tech Stack

- **Frontend**: HTML5, CSS3, vanilla JavaScript (`app.js`)
- **Backend**: Vercel serverless functions (`api/trends.js`, `api/generate.js`)
- **AI / LLM**: Groq API (`llama-3.1-8b-instant` by default, configurable via `GROQ_MODEL`; automatically falls back to another available model if it is retired)
- **Data source**: [`google-trends-api`](https://www.npmjs.com/package/google-trends-api)

## 🛠️ Installation & Setup

### Prerequisites
- Node.js 18.17 or newer
- A [Groq Cloud](https://console.groq.com/) API key

### 1. Clone the repository
```bash
git clone https://github.com/rameshkumark24/trendscript.git
cd trendscript
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment variables
```bash
cp .env.example .env
```
Then edit `.env`:
```env
GROQ_API_KEY=your_groq_api_key_here
# Optional:
# GROQ_MODEL=llama-3.1-8b-instant
```

### 4. Run locally
```bash
npm start          # http://localhost:3000
npm run dev        # same, with auto-restart on file changes
```
The built-in dev server has no dependencies. It serves the frontend and the `/api` routes exactly as Vercel would. You can still use `vercel dev` if you prefer.

### 5. Run tests
```bash
npm test
```

## ☁️ Deployment (Vercel)

1. Import the repository in Vercel. No build step is needed.
2. Add `GROQ_API_KEY` (and optionally `GROQ_MODEL`) under **Project → Settings → Environment Variables**.
3. Deploy. The files in `api/` become serverless functions automatically.

## 🩺 Troubleshooting

| Message in the app | Meaning / fix |
| --- | --- |
| `Server is missing GROQ_API_KEY.` | The variable isn't set for this environment. Add it in Vercel for **Production and Preview**, then redeploy. |
| `Groq rejected the configured GROQ_API_KEY (401)` | The key is wrong, deleted, or revoked. Create a new key at [console.groq.com/keys](https://console.groq.com/keys), update it in Vercel, and redeploy. |
| `The AI provider rejected the request (400: …)` | Groq's own reason is shown after the status code, for example a model or account restriction. If it's about the model, set `GROQ_MODEL` to a model listed in your Groq console. |
| `AI rate limit reached` | You hit Groq's free-tier limit. Wait a minute and try again. |

Changing an environment variable in Vercel only takes effect after a **redeploy**. Each deployment keeps its own URL, so test the latest one (or your production domain), not an older `trendscript-xxxx.vercel.app` link.

## 💡 How to Use

1. **Define your niche**: Enter a broad topic, such as "Tech Reviews", "Fitness", or "React Development", and press **Enter**.
2. **Select a trend**: Pick one of the 6 AI-generated topics built from live search data.
3. **Get your script**: Review the 30-second package, then copy or download it. Click **Regenerate Package** for a new version.

## 🔌 API

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /api/trends` | `{ "category": "Fitness" }` | `{ "trends": string[], "keywords": string[], "source": "google-trends" \| "fallback" }` |
| `POST /api/generate` | `{ "topic": "..." }` | `{ "package": { title, thumbnail_idea, caption, hashtags[], chapters[], script{hook,buildup,climax,cta} } }` |

Errors return `{ "error": "message" }` with a status code: 400 for invalid input, 405 for the wrong method, 429 when rate-limited, 502/504 for AI provider failures, and 500 for other server errors.

## 📂 Project Structure

```text
├── api/
│   ├── _lib/shared.js   # Shared helpers: body parsing, validation, Groq client (not a route)
│   ├── generate.js      # POST /api/generate – production package
│   └── trends.js        # POST /api/trends – Google Trends + AI topic generation
├── scripts/
│   └── dev-server.js    # Zero-dependency local server
├── test/
│   └── api.test.js      # Node test runner suite for the API
├── app.js               # Frontend logic
├── index.html           # Main UI
├── style.css            # Styling
├── 404.html             # Not-found page
├── favicon.svg
├── .env.example
└── package.json
```

## 📝 License
Released under the [MIT License](LICENSE).
