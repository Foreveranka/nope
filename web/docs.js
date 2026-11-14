import {initI18n, mountLanguagePicker, getLanguage, setLanguage, msg, bindText} from './i18n.mjs';

export const DOCS_LANGUAGES = Object.freeze(['tr', 'en', 'de', 'es', 'fr']);
export const MAX_DOCS_BYTES = 128 * 1024;
const UI_KEYS = ['title','skip','home','navigation','sideLabel','workspace','verify','documentation','sideNote','eyebrow','loading','loadError','retry','copy','copied','copyError','exampleLabel','open','backTop','footer'];
const SECTIONS = [['components','cards',6],['workflow','steps',8],['directions','directions',2],['example','example',1],['templates','templates',3],['limits','list',4],['privacy','list',2],['verification','links',2],['faq','faq',5],['glossary','glossary',6]];
const ROUTES = new Set(['', '/workspace', '/verify']);
const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const string = value => typeof value === 'string' && value.length <= 8192;

export function validateDocs(value, language) {
  const fail = () => { throw Error('Invalid documentation catalog'); };
  if (!DOCS_LANGUAGES.includes(language) || !ownKeys(value, ['version','locale','ui','page','sections']) || value.version !== 1 || value.locale !== language) fail();
  if (!ownKeys(value.ui, UI_KEYS) || !Object.values(value.ui).every(v => string(v) && v.trim()) || !ownKeys(value.page, ['title','intro']) || !Object.values(value.page).every(v => string(v) && v.trim())) fail();
  if (!Array.isArray(value.sections) || value.sections.length !== SECTIONS.length) fail();
  const ids = new Set();
  value.sections.forEach((section, index) => {
    const [id, kind, count] = SECTIONS[index];
    if (!ownKeys(section, ['id','kind','title','intro','items']) || section.id !== id || section.kind !== kind || !string(section.title) || !string(section.intro) || !Array.isArray(section.items) || section.items.length !== count) fail();
    section.items.forEach(item => {
      if (!ownKeys(item, ['id','title','text','code','href']) || !/^[a-z][a-z0-9-]{0,50}$/.test(item.id) || ids.has(item.id) || ![item.title,item.text,item.code].every(string) || !ROUTES.has(item.href)) fail();
      ids.add(item.id);
    });
  });
  return value;
}

export async function fetchDocs(language, fetcher = globalThis.fetch) {
  if (!DOCS_LANGUAGES.includes(language)) throw Error('Unsupported documentation language');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetcher(`/docs-locales/${language}.json`, {credentials:'same-origin', redirect:'error', signal:controller.signal});
    if (!response.ok || Number(response.headers?.get('content-length')) > MAX_DOCS_BYTES) throw Error('Documentation unavailable');
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_DOCS_BYTES) { controller.abort(); throw Error('Documentation too large'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    } else {
      text = await response.text();
      if (new TextEncoder().encode(text).length > MAX_DOCS_BYTES) throw Error('Documentation too large');
    }
    return validateDocs(JSON.parse(text), language);
  } finally { clearTimeout(timer); }
}

export async function loadDocsLocale(language, {fetcher = globalThis.fetch, cache = new Map()} = {}) {
  async function load(code) {
    if (cache.has(code)) return cache.get(code);
    const value = await fetchDocs(code, fetcher); cache.set(code, value); return value;
  }
  try { return {language, catalog:await load(language)}; }
  catch (error) {
    if (language === 'en') throw error;
    return {language:'en', catalog:await load('en')};
  }
}

export function renderDocs(catalog, {document:doc, window:win}) {
  const node = (tag, text, className) => {
    const result = doc.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const ui = catalog.ui;
  doc.title = ui.title;
  for (const target of doc.querySelectorAll('[data-docs-ui]')) target.textContent = ui[target.dataset.docsUi];
  doc.getElementById('docs-brand').setAttribute('aria-label', ui.home);
  const nav = doc.getElementById('docs-nav'); nav.setAttribute('aria-label', ui.navigation); nav.replaceChildren();
  doc.getElementById('docs-title').textContent = catalog.page.title;
  doc.getElementById('docs-intro').textContent = catalog.page.intro;
  const root = doc.getElementById('docs-root'); root.replaceChildren();
  function codeBlock(item, copyable) {
    const box = node('div', undefined, 'docs-code');
    box.append(node('p', ui.exampleLabel, 'card-label'));
    const pre = node('pre'), code = node('code', item.code); pre.append(code); pre.tabIndex = 0; box.append(pre);
    if (copyable) {
      const actions = node('div', undefined, 'actions'), button = node('button', ui.copy, 'secondary'); button.type = 'button';
      button.setAttribute('aria-label', `${ui.copy}: ${item.title}`);
      const status = node('p', '', 'docs-copy-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      button.addEventListener('click', async () => {
        try { await win.navigator.clipboard.writeText(item.code); status.textContent = ui.copied; }
        catch { status.textContent = ui.copyError; }
      });
      actions.append(button); box.append(actions, status);
    }
    return box;
  }
  for (const section of catalog.sections) {
    const link = node('a', section.title); link.href = `#${section.id}`; nav.append(link);
    const panel = node('section', undefined, 'card stack docs-section'); panel.id = section.id;
    const heading = node('h2', section.title); heading.id = `${section.id}-heading`; panel.setAttribute('aria-labelledby', heading.id);
    panel.append(heading, node('p', section.intro, 'docs-section-intro'));
    if (section.kind === 'glossary') {
      const list = node('dl', undefined, 'docs-glossary');
      for (const item of section.items) list.append(node('dt', item.title), node('dd', item.text));
      panel.append(list);
    } else {
      const list = node(section.kind === 'steps' ? 'ol' : 'div', undefined, `docs-items${section.kind === 'cards' ? ' docs-cards' : ''}${section.kind === 'steps' ? ' docs-steps' : ''}`);
      section.items.forEach((item, index) => {
        if (section.kind === 'faq') {
          const details = node('details', undefined, 'docs-faq'); details.append(node('summary', item.title), node('p', item.text)); list.append(details); return;
        }
        const entry = node(section.kind === 'steps' ? 'li' : 'article', undefined, 'docs-item');
        if (section.kind === 'steps') entry.append(node('span', String(index + 1).padStart(2, '0'), 'docs-number'));
        entry.append(node('h3', item.title), node('p', item.text));
        if (item.code) entry.append(codeBlock(item, section.kind === 'templates'));
        if (item.href) { const action = node('a', section.kind === 'links' && item.href === '/verify' ? ui.verify : ui.open, 'btn secondary'); action.href = item.href; entry.append(action); }
        list.append(entry);
      });
      panel.append(list);
    }
    const back = node('a', ui.backTop, 'docs-back'); back.href = '#docs-top'; panel.append(back); root.append(panel);
  }
  doc.getElementById('docs-heading').hidden = false;
  root.setAttribute('aria-busy', 'false');
}

export async function startDocs({document:doc = globalThis.document, window:win = globalThis.window, fetcher = globalThis.fetch} = {}) {
  try { await initI18n({document:doc, window:win, fetch:fetcher}); }
  catch { setLanguage('en', {persist:false}); }
  bindText(doc.querySelector('#docs-brand span'), msg('PRIVATE WORK'));
  mountLanguagePicker({document:doc, window:win});
  const cache = new Map(); let generation = 0, current, suppressLanguageEvent = false;
  const status = doc.getElementById('docs-status'), retry = doc.getElementById('docs-retry'), root = doc.getElementById('docs-root');
  function markAnchor() {
    for (const link of doc.getElementById('docs-nav').querySelectorAll('a')) {
      if (link.getAttribute('href') === win.location.hash) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    }
  }
  async function update() {
    const ticket = ++generation;
    root.setAttribute('aria-busy', 'true'); retry.hidden = true;
    if (current) { status.textContent = current.ui.loading; status.hidden = false; }
    try {
      const loaded = await loadDocsLocale(getLanguage(), {fetcher, cache});
      if (ticket !== generation) return;
      if (getLanguage() !== loaded.language) {
        suppressLanguageEvent = true;
        try { setLanguage(loaded.language, {persist:false}); } finally { suppressLanguageEvent = false; }
      }
      const anchor = win.location.hash;
      current = loaded.catalog; renderDocs(current, {document:doc, window:win}); status.hidden = true;
      markAnchor();
      // Rerendering does not replace the hash or add browser history entries.
      if (anchor && anchor === win.location.hash) {
        const target = doc.getElementById(anchor.slice(1)); if (target?.classList.contains('docs-section') || target?.id === 'docs-top') target.scrollIntoView({block:'start'});
      }
    } catch {
      if (ticket !== generation) return;
      root.setAttribute('aria-busy', 'false'); root.replaceChildren(); doc.getElementById('docs-heading').hidden = true;
      // If both the selected catalog and English are unreachable, no guessed
      // documentation is displayed. The already shipped global retry label
      // remains available even before any documentation JSON has loaded.
      status.textContent = current?.ui.loadError || '⚠'; status.hidden = false;
      retry.textContent = current?.ui.retry || String(msg('Yeniden dene')); retry.hidden = false;
    }
  }
  retry.addEventListener('click', update);
  win.addEventListener('nope:languagechange', () => { if (!suppressLanguageEvent) void update(); });
  win.addEventListener('hashchange', markAnchor);
  await update();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') void startDocs();
