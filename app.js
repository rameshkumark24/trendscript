async function loadCustomTrends() {
    const categoryInput = document.getElementById('category-input').value.trim();
    const container = document.getElementById('trends-container');
    const scriptDisplay = document.getElementById('script-display');
    
    if (!categoryInput) return alert("Please enter a category first!");

    container.innerHTML = '<p class="placeholder-text">Scraping Google Trends & analyzing with AI...</p>';
    scriptDisplay.innerHTML = '<p class="placeholder-text">Click a trend to generate your highly-retained Short script.</p>';

    try {
        const response = await fetch('/api/trends', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: categoryInput })
        });
        
        const data = await response.json();
        container.innerHTML = ''; 
        
        if (data.trends.length === 0) {
            container.innerHTML = '<p class="placeholder-text">No trends found. Try a broader term.</p>';
            return;
        }
        
        data.trends.forEach(trend => {
            const btn = document.createElement('button');
            btn.innerText = trend;
            btn.onclick = () => handleTrendSelection(trend);
            container.appendChild(btn);
        });
        
    } catch (error) {
        container.innerHTML = '<p style="color:#ef4444;">Error loading custom trends.</p>';
    }
}

async function handleTrendSelection(topic, forceRegenerate = false) {
    const scriptDisplay = document.getElementById('script-display');
    scriptDisplay.innerHTML = `<p class="placeholder-text">Generating production package for: <strong>${topic}</strong>...</p>`;

    const cachedString = localStorage.getItem(`script_${topic}`);
    
    // Check Cache
    if (cachedString && cachedString !== "undefined" && !forceRegenerate) {
        try {
            const pkg = JSON.parse(cachedString);
            renderPackage(pkg, topic);
            return; 
        } catch(e) { console.log("Cache error, fetching fresh."); }
    }

    // Fetch Fresh
    try {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic: topic })
        });
        
        const data = await response.json();
        
        if (!response.ok || !data.package) throw new Error(data.error || 'Failed to generate package.');
        
        localStorage.setItem(`script_${topic}`, JSON.stringify(data.package));
        renderPackage(data.package, topic);
        
    } catch (error) {
        console.error(error);
        scriptDisplay.innerHTML = `<p style="color: #ef4444;">Error generating script. Check server logs.</p>`;
    }
}

function renderPackage(pkg, topic) {
    const scriptDisplay = document.getElementById('script-display');
    
    const neatHTML = `
        <div class="prod-package">
            <h3 class="vid-title">${pkg.title}</h3>
            <div class="meta-section">
                <p><strong>🎥 Visual/Thumbnail:</strong> ${pkg.thumbnail_idea}</p>
                <p><strong>📝 Caption:</strong> ${pkg.caption}</p>
                <p class="hashtags">${pkg.hashtags.join(' ')}</p>
            </div>
            <div class="script-grid">
                <div class="script-section">
                    <h4>🔥 The Hook (0-3s)</h4>
                    <p>${pkg.script.hook}</p>
                </div>
                <div class="script-section">
                    <h4>📈 Build-up (3-15s)</h4>
                    <p>${pkg.script.buildup}</p>
                </div>
                <div class="script-section">
                    <h4>💥 Climax (15-25s)</h4>
                    <p>${pkg.script.climax}</p>
                </div>
                <div class="script-section">
                    <h4>👇 Call to Action (25-30s)</h4>
                    <p>${pkg.script.cta}</p>
                </div>
            </div>
            <div class="chapters-section">
                <h4>⏱️ Timeline Chapters</h4>
                <ul>
                    ${pkg.chapters.map(ch => `<li><strong>${ch.time}</strong> - ${ch.label}</li>`).join('')}
                </ul>
            </div>
        </div>
    `;
    
    scriptDisplay.innerHTML = neatHTML;
    setupRegenerateButton(topic);
}

function setupRegenerateButton(topic) {
    const container = document.getElementById('action-buttons-container');
    container.innerHTML = ''; 
    const regenBtn = document.createElement('button');
    regenBtn.id = 'regen-btn';
    regenBtn.innerText = 'Regenerate Package';
    regenBtn.onclick = () => handleTrendSelection(topic, true); 
    container.appendChild(regenBtn);
}