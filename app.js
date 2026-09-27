'use strict';

(() => {
    const CACHE_KEY = 'trendscript:v2:packages';
    const PREFS_KEY = 'trendscript:v2:prefs';
    const LEGACY_CACHE_PREFIX = 'script_';
    const MAX_CACHE_ENTRIES = 25;
    const WORDS_PER_SECOND = 2.5; // ~150 words per minute, a typical Shorts voiceover pace
    const TARGET_SECONDS = 30;
    const TARGET_TOLERANCE_SECONDS = 6;

    const PHASES = [
        { key: 'hook', icon: '🔥', label: 'The Hook', window: '0–3s', seconds: 3 },
        { key: 'buildup', icon: '📈', label: 'Build-up', window: '3–15s', seconds: 12 },
        { key: 'climax', icon: '💥', label: 'Climax', window: '15–25s', seconds: 10 },
        { key: 'cta', icon: '👇', label: 'Call to Action', window: '25–30s', seconds: 5 },
    ];

    const SOURCE_LABELS = {
        'google-trends-rising': 'Based on rising Google Trends searches',
        'google-trends-top': 'Based on top Google Trends searches',
        'google-autocomplete': 'Google Trends was unavailable, so these are based on live Google search suggestions',
        fallback: 'Live search data was unavailable, so these topics are AI-suggested from your niche alone.',
    };

    const $ = (id) => document.getElementById(id);
    const dom = {
        nicheForm: $('niche-form'),
        categoryInput: $('category-input'),
        regionSelect: $('region-select'),
        toneSelect: $('tone-select'),
        searchBtn: $('search-btn'),
        trendsStatus: $('trends-status'),
        trendsContainer: $('trends-container'),
        customTopicForm: $('custom-topic-form'),
        customTopicInput: $('custom-topic-input'),
        workspace: $('workspace'),
        scriptDisplay: $('script-display'),
        actions: $('action-buttons-container'),
        historyPanel: $('history-panel'),
        historyList: $('history-list'),
        clearHistoryBtn: $('clear-history-btn'),
        toast: $('toast'),
    };

    const state = {
        niche: '',
        trendsController: null,
        generateController: null,
        current: null, // { key, topic, tone, niche, pkg, savedAt }
    };

    // ---------- DOM helpers (text is always inserted as text nodes) ----------

    function h(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === null || value === undefined || value === false) continue;
            if (key === 'className') node.className = value;
            else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
            else node.setAttribute(key, value === true ? '' : value);
        }
        for (const child of children.flat()) {
            if (child === null || child === undefined || child === false || child === '') continue;
            node.append(child instanceof Node ? child : String(child));
        }
        return node;
    }

    const placeholder = (text) => h('p', { className: 'placeholder-text' }, text);

    const loadingBlock = (...content) =>
        h('div', { className: 'loading-block' }, h('span', { className: 'spinner', 'aria-hidden': 'true' }), h('p', {}, ...content));

    function errorBlock(message, onRetry) {
        return h(
            'div',
            { className: 'alert', role: 'alert' },
            h('p', {}, message),
            onRetry && h('button', { type: 'button', className: 'btn btn-ghost btn-small', onClick: onRetry }, 'Try again'),
        );
    }

    function setBusy(button, busy, busyText) {
        if (busy) {
            button.dataset.label = button.dataset.label || button.textContent;
            button.textContent = busyText;
        } else if (button.dataset.label) {
            button.textContent = button.dataset.label;
        }
        button.disabled = busy;
        button.setAttribute('aria-busy', String(busy));
    }

    let toastTimer;
    function showToast(message) {
        dom.toast.textContent = message;
        dom.toast.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => dom.toast.classList.remove('visible'), 2200);
    }

    function prefersReducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    // ---------- Storage (every access is guarded: private mode, quotas, blocked storage) ----------

    const storage = {
        read(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                return raw ? JSON.parse(raw) : fallback;
            } catch {
                return fallback;
            }
        },
        write(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
                return true;
            } catch {
                return false;
            }
        },
        remove(key) {
            try {
                localStorage.removeItem(key);
            } catch {
                /* storage unavailable */
            }
        },
    };

    // v1 cached raw, unvalidated model output under `script_<topic>` keys.
    function removeLegacyCache() {
        try {
            const legacyKeys = [];
            for (let i = 0; i < localStorage.length; i += 1) {
                const key = localStorage.key(i);
                if (key && key.startsWith(LEGACY_CACHE_PREFIX)) legacyKeys.push(key);
            }
            legacyKeys.forEach((key) => localStorage.removeItem(key));
        } catch {
            /* storage unavailable */
        }
    }

    function isValidPackage(pkg) {
        return (
            Boolean(pkg) &&
            typeof pkg === 'object' &&
            typeof pkg.title === 'string' &&
            Array.isArray(pkg.hashtags) &&
            pkg.hashtags.every((tag) => typeof tag === 'string') &&
            Array.isArray(pkg.chapters) &&
            pkg.chapters.every((chapter) => chapter && typeof chapter.time === 'string' && typeof chapter.label === 'string') &&
            Boolean(pkg.script) &&
            PHASES.every((phase) => typeof pkg.script[phase.key] === 'string')
        );
    }

    function cacheKey(topic, tone) {
        return `${tone}::${topic.toLowerCase()}`;
    }

    function readCache() {
        const entries = storage.read(CACHE_KEY, []);
        if (!Array.isArray(entries)) return [];
        return entries.filter((entry) => entry && typeof entry.key === 'string' && typeof entry.topic === 'string' && isValidPackage(entry.pkg));
    }

    function saveToCache(entry) {
        let entries = [entry, ...readCache().filter((item) => item.key !== entry.key)].slice(0, MAX_CACHE_ENTRIES);
        // If storage is full, keep halving the history until it fits.
        while (!storage.write(CACHE_KEY, entries) && entries.length > 1) {
            entries = entries.slice(0, Math.ceil(entries.length / 2));
        }
        renderHistory();
    }

    function savePrefs() {
        storage.write(PREFS_KEY, {
            niche: dom.categoryInput.value.trim(),
            region: dom.regionSelect.value,
            tone: dom.toneSelect.value,
        });
    }

    function selectIfAvailable(select, value) {
        if (typeof value === 'string' && [...select.options].some((option) => option.value === value)) {
            select.value = value;
        }
    }

    function restorePrefs() {
        const prefs = storage.read(PREFS_KEY, {});
        if (!prefs || typeof prefs !== 'object') return;
        if (typeof prefs.niche === 'string') dom.categoryInput.value = prefs.niche.slice(0, 80);
        selectIfAvailable(dom.regionSelect, prefs.region);
        selectIfAvailable(dom.toneSelect, prefs.tone);
    }

    // ---------- API ----------

    async function postJson(path, payload, signal) {
        let response;
        try {
            response = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal,
            });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw new Error('Network error. Check your connection and try again.');
        }

        let data = null;
        try {
            data = await response.json();
        } catch {
            /* non-JSON body, e.g. a platform error page */
        }

        if (!response.ok) {
            throw new Error((data && data.error) || `Request failed (HTTP ${response.status}). Please try again.`);
        }
        if (!data) throw new Error('The server returned an unexpected response. Please try again.');
        return data;
    }

    // ---------- Step 2: trends ----------

    function setTrendsStatus(message, tone = 'info') {
        dom.trendsStatus.textContent = message;
        dom.trendsStatus.dataset.tone = tone;
        dom.trendsStatus.hidden = !message;
    }

    function describeSource(source, keywords) {
        const label = SOURCE_LABELS[source];
        if (!label) return '';
        if (source === 'fallback' || !Array.isArray(keywords) || !keywords.length) return label;
        return `${label}: ${keywords.slice(0, 5).join(', ')}${keywords.length > 5 ? '…' : ''}`;
    }

    function highlightActiveTrend() {
        const activeTopic = state.current ? state.current.topic : null;
        dom.trendsContainer.querySelectorAll('.trend-btn').forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.topic === activeTopic));
        });
    }

    function renderTrends(trends) {
        const buttons = trends.map((trend) =>
            h(
                'button',
                {
                    type: 'button',
                    className: 'trend-btn',
                    'data-topic': trend,
                    'aria-pressed': 'false',
                    onClick: () => generatePackage(trend, { scroll: true }),
                },
                trend,
            ),
        );
        dom.trendsContainer.replaceChildren(...buttons);
        highlightActiveTrend();
    }

    async function findTrends(event) {
        event.preventDefault();
        const category = dom.categoryInput.value.trim();
        if (category.length < 2) {
            setTrendsStatus('Enter a niche of at least 2 characters first.', 'error');
            dom.categoryInput.focus();
            return;
        }

        if (state.trendsController) state.trendsController.abort();
        const controller = new AbortController();
        state.trendsController = controller;
        state.niche = category;
        savePrefs();

        setBusy(dom.searchBtn, true, 'Finding…');
        setTrendsStatus('');
        dom.trendsContainer.replaceChildren(loadingBlock('Pulling live search data for ', h('strong', {}, category), ' and shaping it into Shorts topics…'));

        try {
            const data = await postJson('/api/trends', { category, region: dom.regionSelect.value }, controller.signal);
            const trends = Array.isArray(data.trends) ? data.trends.filter((trend) => typeof trend === 'string' && trend.trim()) : [];
            if (!trends.length) {
                dom.trendsContainer.replaceChildren(placeholder('No trends found. Try a broader niche.'));
                return;
            }
            renderTrends(trends);
            setTrendsStatus(describeSource(data.source, data.keywords), data.source === 'fallback' ? 'warn' : 'info');
        } catch (error) {
            if (error.name === 'AbortError') return;
            dom.trendsContainer.replaceChildren(errorBlock(error.message, () => dom.nicheForm.requestSubmit()));
        } finally {
            if (state.trendsController === controller) {
                state.trendsController = null;
                setBusy(dom.searchBtn, false);
            }
        }
    }

    // ---------- Step 3: production package ----------

    function countWords(text) {
        const trimmed = String(text || '').trim();
        return trimmed ? trimmed.split(/\s+/).length : 0;
    }

    function toneLabel(tone) {
        const option = [...dom.toneSelect.options].find((item) => item.value === tone);
        return option ? option.textContent : tone;
    }

    function timeAgo(timestamp) {
        const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
        if (seconds < 60) return 'just now';
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes} min ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours} h ago`;
        return new Date(timestamp).toLocaleDateString();
    }

    function copyButton(text, label) {
        return h('button', { type: 'button', className: 'btn btn-ghost btn-small', onClick: () => copyText(text) }, label);
    }

    function renderPackage(entry, { fromCache }) {
        const { pkg } = entry;
        const totalWords = PHASES.reduce((sum, phase) => sum + countWords(pkg.script[phase.key]), 0);
        const totalSeconds = Math.round(totalWords / WORDS_PER_SECOND);
        const fitsTarget = Math.abs(totalSeconds - TARGET_SECONDS) <= TARGET_TOLERANCE_SECONDS;
        const socialText = [pkg.caption, pkg.hashtags.join(' ')].filter(Boolean).join('\n\n');

        const article = h(
            'article',
            { className: 'prod-package' },
            h(
                'p',
                { className: 'package-meta' },
                `Topic: ${entry.topic} · Tone: ${toneLabel(entry.tone)}`,
                fromCache ? ` · Saved ${timeAgo(entry.savedAt)}` : '',
            ),
            h('div', { className: 'title-row' }, h('h3', { className: 'vid-title' }, pkg.title), copyButton(pkg.title, 'Copy title')),
            h(
                'div',
                { className: 'meta-section' },
                pkg.thumbnail_idea && h('p', {}, h('strong', {}, '🎥 Visual / thumbnail: '), pkg.thumbnail_idea),
                pkg.caption && h('p', {}, h('strong', {}, '📝 Caption: '), pkg.caption),
                h('p', { className: 'hashtags' }, pkg.hashtags.join(' ')),
                copyButton(socialText, 'Copy caption + hashtags'),
            ),
            h(
                'p',
                {
                    className: `duration-badge ${fitsTarget ? 'ok' : 'warn'}`,
                    title: `Estimated at ${WORDS_PER_SECOND * 60} words per minute. Aim for about ${TARGET_SECONDS * WORDS_PER_SECOND} words.`,
                },
                `⏱ ≈ ${totalSeconds}s spoken · ${totalWords} words`,
                fitsTarget ? ' · fits a 30s Short' : ` · target ≈ ${TARGET_SECONDS}s, consider trimming or extending`,
            ),
            h(
                'div',
                { className: 'script-grid' },
                PHASES.map((phase) => {
                    const text = pkg.script[phase.key];
                    const words = countWords(text);
                    const seconds = (words / WORDS_PER_SECOND).toFixed(1);
                    return h(
                        'section',
                        { className: 'script-section' },
                        h('h4', {}, `${phase.icon} ${phase.label} (${phase.window})`),
                        h('p', {}, text),
                        h('p', { className: 'phase-meta' }, `${words} words · ≈ ${seconds}s of ${phase.seconds}s`),
                    );
                }),
            ),
            h(
                'div',
                { className: 'chapters-section' },
                h('h4', {}, '⏱️ Timeline chapters'),
                h(
                    'ul',
                    {},
                    pkg.chapters.map((chapter) => h('li', {}, h('strong', {}, String(chapter.time)), ` – ${chapter.label}`)),
                ),
            ),
        );

        dom.scriptDisplay.replaceChildren(article);
    }

    function showPackage(entry, { fromCache = false } = {}) {
        state.current = entry;
        renderPackage(entry, { fromCache });
        dom.actions.hidden = false;
        highlightActiveTrend();
    }

    function clearCurrent() {
        state.current = null;
        dom.actions.hidden = true;
        highlightActiveTrend();
    }

    function scrollToWorkspace() {
        const { top } = dom.workspace.getBoundingClientRect();
        if (top > window.innerHeight * 0.6 || top < 0) {
            dom.workspace.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
        }
    }

    async function generatePackage(topic, { force = false, niche = state.niche, tone = dom.toneSelect.value, scroll = false } = {}) {
        const key = cacheKey(topic, tone);

        if (state.generateController) {
            state.generateController.abort();
            state.generateController = null;
        }
        if (scroll) scrollToWorkspace();

        if (!force) {
            const cached = readCache().find((entry) => entry.key === key);
            if (cached) {
                showPackage(cached, { fromCache: true });
                return;
            }
        }

        const controller = new AbortController();
        state.generateController = controller;
        clearCurrent();
        // Highlight the requested trend while it generates.
        dom.trendsContainer.querySelectorAll('.trend-btn').forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.topic === topic));
        });
        dom.scriptDisplay.replaceChildren(loadingBlock('Writing a 30-second production package for ', h('strong', {}, topic), '…'));

        try {
            const data = await postJson('/api/generate', { topic, niche, tone }, controller.signal);
            if (!isValidPackage(data.package)) throw new Error('The server returned an incomplete package. Please try again.');
            const entry = { key, topic, tone, niche, pkg: data.package, savedAt: Date.now() };
            saveToCache(entry);
            showPackage(entry);
        } catch (error) {
            if (error.name === 'AbortError') return;
            dom.scriptDisplay.replaceChildren(errorBlock(error.message, () => generatePackage(topic, { force, niche, tone })));
        } finally {
            if (state.generateController === controller) state.generateController = null;
        }
    }

    // ---------- Export ----------

    function toScriptText(pkg) {
        return PHASES.map((phase) => pkg.script[phase.key]).join('\n\n');
    }

    function toMarkdown(entry) {
        const { pkg } = entry;
        const lines = [`# ${pkg.title}`, '', `**Topic:** ${entry.topic}  `, `**Tone:** ${toneLabel(entry.tone)}`, ''];
        if (pkg.thumbnail_idea) lines.push('## Opening shot / thumbnail', '', pkg.thumbnail_idea, '');
        lines.push('## Caption', '', pkg.caption || '_(none)_', '', pkg.hashtags.join(' '), '');
        lines.push('## Script (30 seconds)', '');
        PHASES.forEach((phase) => lines.push(`### ${phase.label} (${phase.window})`, '', pkg.script[phase.key], ''));
        lines.push('## Timeline', '', ...pkg.chapters.map((chapter) => `- ${chapter.time} ${chapter.label}`), '');
        lines.push('_Generated with TrendScript_', '');
        return lines.join('\n');
    }

    function slugify(text) {
        const slug = text
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60);
        return slug || 'trendscript-package';
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
            } else {
                const textarea = h('textarea', { readonly: true, className: 'offscreen' });
                textarea.value = text;
                document.body.append(textarea);
                textarea.select();
                const copied = document.execCommand('copy');
                textarea.remove();
                if (!copied) throw new Error('execCommand copy failed');
            }
            showToast('Copied to clipboard');
        } catch {
            showToast('Copy failed. Select the text and copy it manually.');
        }
    }

    function downloadText(filename, text) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
        const link = h('a', { href: url, download: filename, className: 'offscreen' });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function onActionClick(event) {
        const button = event.target.closest('button[data-action]');
        const entry = state.current;
        if (!button || !entry) return;

        switch (button.dataset.action) {
            case 'copy-script':
                copyText(toScriptText(entry.pkg));
                break;
            case 'copy-all':
                copyText(toMarkdown(entry));
                break;
            case 'download':
                downloadText(`${slugify(entry.pkg.title)}.md`, toMarkdown(entry));
                showToast('Download started');
                break;
            case 'regenerate':
                generatePackage(entry.topic, { force: true, niche: entry.niche, tone: dom.toneSelect.value });
                break;
            default:
                break;
        }
    }

    // ---------- History ----------

    function renderHistory() {
        const entries = readCache();
        dom.historyPanel.hidden = entries.length === 0;
        dom.historyList.replaceChildren(
            ...entries.map((entry) =>
                h(
                    'li',
                    {},
                    h(
                        'button',
                        {
                            type: 'button',
                            className: 'history-item',
                            onClick: () => {
                                selectIfAvailable(dom.toneSelect, entry.tone);
                                showPackage(entry, { fromCache: true });
                                scrollToWorkspace();
                            },
                        },
                        h('span', { className: 'history-title' }, entry.pkg.title),
                        h('span', { className: 'history-meta' }, `${entry.topic} · ${toneLabel(entry.tone)} · ${timeAgo(entry.savedAt)}`),
                    ),
                ),
            ),
        );
    }

    function clearHistory() {
        if (!window.confirm('Delete all saved packages from this browser?')) return;
        storage.remove(CACHE_KEY);
        renderHistory();
        showToast('Saved packages cleared');
    }

    // ---------- Init ----------

    function init() {
        removeLegacyCache();
        restorePrefs();

        dom.nicheForm.addEventListener('submit', findTrends);
        dom.customTopicForm.addEventListener('submit', (event) => {
            event.preventDefault();
            const topic = dom.customTopicInput.value.trim();
            if (topic.length < 3) {
                showToast('Enter a topic of at least 3 characters.');
                dom.customTopicInput.focus();
                return;
            }
            generatePackage(topic, { scroll: true });
        });
        dom.actions.addEventListener('click', onActionClick);
        dom.clearHistoryBtn.addEventListener('click', clearHistory);
        dom.regionSelect.addEventListener('change', savePrefs);
        dom.toneSelect.addEventListener('change', savePrefs);

        renderHistory();
    }

    init();
})();
