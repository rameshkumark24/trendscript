export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  
  const { topic } = req.body;
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'Missing API Key.' });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        response_format: { type: "json_object" }, 
        messages: [
          { 
            role: 'system', 
            content: `You are an elite YouTube Producer AI. Generate a complete, ready-to-publish production package.
            INSTRUCTIONS: Output strictly valid JSON. The script must be exactly 30 seconds, broken into 4 distinct phases. Generate SEO-optimized metadata. Provide a creative visual thumbnail concept.
            REQUIRED JSON SCHEMA:
            {
              "title": "High-CTR Video Title",
              "thumbnail_idea": "Visual description of the opening shot",
              "caption": "A 2-sentence engaging description for the algorithm",
              "hashtags": ["#tag1", "#tag2", "#tag3"],
              "chapters": [
                {"time": "0:00", "label": "The Hook"},
                {"time": "0:03", "label": "Context..."}
              ],
              "script": {
                "hook": "0-3s script text",
                "buildup": "3-15s script text",
                "climax": "15-25s script text",
                "cta": "25-30s script text"
              }
            }` 
          },
          { role: 'user', content: `Create a production package for the topic: ${topic}` }
        ]
      })
    });
    
    const data = await response.json();
    if (!response.ok || data.error) return res.status(500).json({ error: 'Groq rejected the request.' });

    const productionPackage = JSON.parse(data.choices[0].message.content);
    res.status(200).json({ package: productionPackage });

  } catch (error) {
    console.error("🔴 SERVER ERROR:", error);
    res.status(500).json({ error: 'Failed to generate script.' });
  }
}