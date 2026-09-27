'use strict';

const CACHE_PREFIX = 'trendscript:v2:';
const CACHE_INDEX_KEY = `${CACHE_PREFIX}index`;
const LAST_NICHE_KEY = `${CACHE_PREFIX}last-niche`;
const MAX_CACHE_ENTRIES = 25;
const WORDS_PER_SECOND = 2.6; // typical Shorts narration pace

const PHASES = [
    { key: 'hook', label: '🔥 The Hook (0-3s)' },
    { key: 'buildup', label: '📈 Build-up (3-15s)' },
    { key: 'climax', label: '💥 Climax (15-25s)' },
    { key: 'cta', label: '👇 Call to Action (25-30s)' },
];

const els = {
    form: document.getElementById('search-form'),
    input: document.getElementById('category-input'),
    searchBtn: document.getElementById('search-btn'),
    hint: document.getElementById('search-hint'),
    trends: document.getElementById('trends-container'),
    script: document.getElementById('script-display'),
    actions: document.getElementById('action-buttons-container'),
    toast: document.getElementById('toast'),
};

// Incremented on every generate request so a slow, stale response can't
// overwrite the package for a trend the user clicked afterwards.
let generateRequestId = 0;
let currentTopic = null;
let currentPackage = null;

/* ---------- Storage (localStorage can throw in private mode / when full) ---------- */

const storage = {
    get(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); return true; } catch { return false; }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
    },
};

function cacheKey(topic) {
    return `${CACHE_PREFIX}script:${topic.toLowerCase()}`;
}

function readCache(topic) {
    const raw = storage.get(cacheKey(topic));
    if (!raw) return null;
    try {
        const pkg = JSON.parse(raw);
        return isValidPackage(pkg) ? pkg : null;
    } catch {
        storage.remove(cacheKey(topic));
        return null;
    }
}

function writeCache(topic, pkg) {
    let index;
    try { index = JSON.parse(storage.get(CACHE_INDEX_KEY) || '[]'); } catch { index = []; }
    if (!Array.isArray(index)) index = [];

    const key = cacheKey(topic);
    index = [key, ...index.filter(k => k !== key)];
    // Evict the oldest entries so the cache never grows unbounded.
    index.splice(MAX_CACHE_ENTRIES).forEach(storage.remove);

    storage.set(key, JSON.stringify(pkg));
    storage.set(CACHE_INDEX_KEY, JSON.stringify(index));
}

function isValidPackage(pkg) {
    return Boolean(
        pkg && typeof pkg.title === 'string' && Array.isArray(pkg.hashtags) &&
        Array.isArray(pkg.chapters) && pkg.script &&
        PHASES.every(p => typeof pkg.script[p.key] === 'string')
    );
}

/* ---------- DOM helpers (textContent only: AI output is never parsed as HTML) ---------- */

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value);
    }
    children.flat().forEach(child => {
        if (child !== null && child !== undefined) {
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
    });
    return node;
}

function showMessage(container, message, type = 'placeholder') {
    const cls = type === 'error' ? 'error-text' : 'placeholder-text';
    container.replaceChildren(el('p', { className: cls, text: message }));
}

function showLoading(container, message) {
    container.replaceChildren(el('p', { className: 'loading-text' }, el('span', { className: 'spinner', 'aria-hidden': 'true' }), message));
}

let toastTimer;
function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 2200);
}

async function postJson(url, payload) {
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch {
        throw new Error('Network error. Check your connection and try again.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
}

/* ---------- Step 1 + 2: Trends ---------- */

async function loadCustomTrends(event) {
    event?.preventDefault();
    const category = els.input.value.trim();

    if (!category) {
        els.hint.textContent = 'Please enter a niche first.';
        els.input.focus();
        return;
    }

    els.hint.textContent = '';
    els.searchBtn.disabled = true;
    els.searchBtn.textContent = 'Searching…';
    showLoading(els.trends, 'Scraping Google Trends & analyzing with AI…');
    resetWorkspace();
    storage.set(LAST_NICHE_KEY, category);

    try {
        const data = await postJson('/api/trends', { category });
        const trends = Array.isArray(data.trends) ? data.trends : [];

        if (!trends.length) {
            showMessage(els.trends, 'No trends found. Try a broader term.');
            return;
        }

        els.trends.replaceChildren(...trends.map(trend =>
            el('button', { type: 'button', className: 'trend-btn', title: trend, onClick: () => handleTrendSelection(trend) }, trend)
        ));

        if (data.source === 'fallback') {
            els.hint.textContent = 'Google Trends was unavailable, so topics are based on your niche directly.';
        } else if (Array.isArray(data.keywords) && data.keywords.length) {
            els.hint.textContent = `Based on searches like: ${data.keywords.slice(0, 4).join(', ')}`;
        }
    } catch (error) {
        showMessage(els.trends, error.message || 'Error loading trends.', 'error');
    } finally {
        els.searchBtn.disabled = false;
        els.searchBtn.textContent = 'Find Trends';
    }
}

function resetWorkspace() {
    generateRequestId++;
    currentTopic = null;
    currentPackage = null;
    showMessage(els.script, 'Click a trend to generate your highly-retained Short script.');
    els.actions.replaceChildren();
}

function markActiveTrend(topic) {
    els.trends.querySelectorAll('.trend-btn').forEach(btn => {
        const active = btn.textContent === topic;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
    });
}

/* ---------- Step 3: Production package ---------- */

async function handleTrendSelection(topic, forceRegenerate = false) {
    const requestId = ++generateRequestId;
    currentTopic = topic;
    markActiveTrend(topic);

    if (!forceRegenerate) {
        const cached = readCache(topic);
        if (cached) {
            renderPackage(cached, topic, true);
            return;
        }
    }

    showLoading(els.script, `Generating production package for “${topic}”…`);
    setActionsDisabled(true);

    try {
        const data = await postJson('/api/generate', { topic });
        if (requestId !== generateRequestId) return; // user moved on
        if (!isValidPackage(data.package)) throw new Error('The AI returned an incomplete package. Please try again.');

        writeCache(topic, data.package);
        renderPackage(data.package, topic, false);
    } catch (error) {
        if (requestId !== generateRequestId) return;
        console.error(error);
        showMessage(els.script, error.message || 'Error generating script.', 'error');
        renderActions(topic);
    }
}

function countWords(text) {
    return (text.match(/\S+/g) || []).length;
}

function renderPackage(pkg, topic, fromCache) {
    currentPackage = pkg;
    const words = PHASES.reduce((sum, p) => sum + countWords(pkg.script[p.key]), 0);
    const seconds = Math.round(words / WORDS_PER_SECOND);
    const timingClass = seconds > 34 ? 'badge warn' : 'badge';

    const view = el('div', { className: 'prod-package' },
        el('div', { className: 'title-row' },
            el('h3', { className: 'vid-title', text: pkg.title }),
            el('button', { type: 'button', className: 'icon-btn', title: 'Copy title', onClick: () => copyText(pkg.title, 'Title copied') }, 'Copy')
        ),
        el('div', { className: 'badges' },
            el('span', { className: timingClass, text: `${words} words · ~${seconds}s read` }),
            fromCache ? el('span', { className: 'badge muted', text: 'Loaded from cache' }) : null
        ),
        el('div', { className: 'meta-section' },
            pkg.thumbnail_idea ? el('p', {}, el('strong', { text: '🎥 Visual/Thumbnail: ' }), pkg.thumbnail_idea) : null,
            pkg.caption ? el('p', {}, el('strong', { text: '📝 Caption: ' }), pkg.caption) : null,
            pkg.hashtags.length ? el('p', { className: 'hashtags', text: pkg.hashtags.join(' ') }) : null
        ),
        el('div', { className: 'script-grid' },
            PHASES.map(p => el('div', { className: 'script-section' },
                el('h4', { text: p.label }),
                el('p', { text: pkg.script[p.key] })
            ))
        ),
        el('div', { className: 'chapters-section' },
            el('h4', { text: '⏱️ Timeline Chapters' }),
            el('ul', {}, pkg.chapters.map(ch => el('li', {}, el('strong', { text: ch.time }), ` – ${ch.label}`)))
        )
    );

    els.script.replaceChildren(view);
    renderActions(topic);
}

function setActionsDisabled(disabled) {
    els.actions.querySelectorAll('button').forEach(btn => { btn.disabled = disabled; });
}

function renderActions(topic) {
    const buttons = [
        el('button', { type: 'button', id: 'regen-btn', onClick: () => handleTrendSelection(topic, true) }, 'Regenerate Package'),
    ];
    if (currentPackage && currentTopic === topic) {
        buttons.push(
            el('button', { type: 'button', className: 'secondary-btn', onClick: () => copyText(scriptToText(currentPackage), 'Voiceover script copied') }, 'Copy Script'),
            el('button', { type: 'button', className: 'secondary-btn', onClick: () => copyText(packageToMarkdown(currentPackage), 'Full package copied') }, 'Copy All'),
            el('button', { type: 'button', className: 'secondary-btn', onClick: () => downloadMarkdown(currentPackage) }, 'Download .md')
        );
    }
    els.actions.replaceChildren(...buttons);
}

/* ---------- Export ---------- */

function scriptToText(pkg) {
    return PHASES.map(p => pkg.script[p.key]).join('\n\n');
}

function packageToMarkdown(pkg) {
    return [
        `# ${pkg.title}`,
        '',
        pkg.thumbnail_idea && `**Visual/Thumbnail:** ${pkg.thumbnail_idea}`,
        pkg.caption && `**Caption:** ${pkg.caption}`,
        pkg.hashtags.length && `**Hashtags:** ${pkg.hashtags.join(' ')}`,
        '',
        '## Script',
        ...PHASES.flatMap(p => [`### ${p.label.replace(/^\S+\s/, '')}`, pkg.script[p.key], '']),
        '## Chapters',
        ...pkg.chapters.map(ch => `- ${ch.time} ${ch.label}`),
        '',
    ].filter(line => typeof line === 'string').join('\n');
}

async function copyText(text, successMessage) {
    try {
        await navigator.clipboard.writeText(text);
        toast(successMessage);
    } catch {
        // Fallback for non-secure contexts where the Clipboard API is unavailable.
        const area = el('textarea', { readonly: '', style: 'position:fixed;opacity:0' });
        area.value = text;
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        toast(ok ? successMessage : 'Copy failed. Please copy manually.');
    }
}

function downloadMarkdown(pkg) {
    const slug = pkg.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'short-script';
    const url = URL.createObjectURL(new Blob([packageToMarkdown(pkg)], { type: 'text/markdown' }));
    const link = el('a', { href: url, download: `${slug}.md` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Init ---------- */

els.form.addEventListener('submit', loadCustomTrends);
els.input.value = storage.get(LAST_NICHE_KEY) || '';
