# TrendScript 📈🎬

TrendScript is a data-driven web application that generates highly-retained, 30-second YouTube Shorts production packages in milliseconds. By combining real-time search data from Google Trends with Groq's blazing-fast LLaMA 3.1 AI model, TrendScript helps creators find breakout topics and instantly generates ready-to-publish scripts.

## ✨ Features

- **Real-Time Trend Discovery**: Scrapes current Google Trends data to find breakout queries for any specified niche.
- **AI-Powered Title Generation**: Converts raw search keywords into highly specific, engaging, and clickable video topics.
- **Complete Production Packages**: Instantly generates a structured JSON payload containing:
  - High-CTR video titles
  - Visual/thumbnail concepts for the opening shot
  - SEO-optimized captions and hashtags
  - A strictly timed 4-phase script (Hook, Build-up, Climax, CTA)
  - Timed chapters for YouTube
- **Caching Mechanism**: Uses `localStorage` to save previously generated scripts, saving API calls and providing instant load times for revisited trends.
- **Modern UI**: A responsive, dark-mode workspace built with CSS grid and flexbox.

## 🚀 Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript (`app.js`)
- **Backend / API**: Serverless Functions (`/api/trends.js`, `/api/generate.js`)
- **AI / LLM**: Groq API (`llama-3.1-8b-instant`)
- **Data Source**: `google-trends-api` (npm package)

## 🛠️ Installation & Setup

### Prerequisites
- Node.js installed on your machine
- A [Groq Cloud](https://console.groq.com/) account for the API key
- Vercel CLI (recommended, since the project utilizes `/api` serverless routes)

### 1. Clone the repository
\`\`\`bash
git clone <your-repository-url>
cd trendscript
\`\`\`

### 2. Install Dependencies
Installs the required `google-trends-api` package.
\`\`\`bash
npm install
\`\`\`

### 3. Configure Environment Variables
Create a `.env` file in the root of your project and add your Groq API key:
\`\`\`env
GROQ_API_KEY=your_groq_api_key_here
\`\`\`

### 4. Run the Development Server
Because this project uses serverless API routes (`/api/generate.js` and `/api/trends.js`), the easiest way to run it locally is using Vercel CLI:
\`\`\`bash
npm i -g vercel
vercel dev
\`\`\`
*(Alternatively, you can deploy it directly to Vercel or Firebase Hosting).*

## 💡 How to Use

1. **Define Your Niche**: Enter a broad topic (e.g., "Tech Reviews", "Fitness", "React Development") into the search bar.
2. **Select a Trend**: The app fetches real-time related queries from Google Trends and uses AI to format them into 6 actionable hook-driven topics.
3. **Get Your Script**: Click on a generated trend to instantly create a 30-second production package complete with a script, thumbnail ideas, and metadata.

## 📂 Project Structure

\`\`\`text
├── api/
│   ├── generate.js    # Endpoint for generating the final video script
│   └── trends.js      # Endpoint for fetching and parsing Google Trends
├── app.js             # Main frontend logic and DOM manipulation
├── index.html         # Main application UI
├── style.css          # Custom styling and dark-mode layout
├── 404.html           # Fallback error page
├── package.json       # Project dependencies
└── .gitignore         # Ignored files and directories
\`\`\`

## 📝 License
This project is open-source and available under the [MIT License](LICENSE).
