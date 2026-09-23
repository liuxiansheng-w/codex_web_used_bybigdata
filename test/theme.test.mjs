import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createThemeControl, createAppearanceControl, createModuleThemeControls } from '../public/interactions.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
function setup(t, storage) {
  const dom = new JSDOM(html, { url: 'http://localhost' }); t.after(() => dom.window.close());
  const document = dom.window.document, root = document.documentElement, button = document.getElementById('themeToggle'), colorMeta = document.getElementById('themeColor');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  const control = createThemeControl({ root, button, colorMeta, storage: storage || dom.window.localStorage });
  return { window: dom.window, document, root, button, colorMeta, control };
}

test('theme button toggles warm light/dark, remembers choice and restores it on a new page', t => {
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const page = setup(t, storage);
  assert.equal(page.control.theme, 'dark'); assert.equal(page.button.type, 'button');
  page.button.click(); assert.equal(page.root.dataset.theme, 'light'); assert.equal(page.button.getAttribute('aria-pressed'), 'true'); assert.match(page.button.title, /切换深色/);
  assert.equal(page.colorMeta.content, '#eeede8'); assert.equal(saved.get('codex-desk:theme'), 'light');
  const nextPage = setup(t, storage); assert.equal(nextPage.control.theme, 'light');
  nextPage.button.click(); assert.equal(nextPage.root.dataset.theme, 'dark'); assert.equal(nextPage.button.getAttribute('aria-pressed'), 'false'); assert.equal(nextPage.colorMeta.content, '#090c12'); assert.equal(saved.get('codex-desk:theme'), 'dark');
});

test('theme gracefully handles invalid preference and unavailable browser storage', t => {
  for (const storage of [{ getItem: () => 'invalid', setItem() {} }, { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Quota'); } }]) {
    const { root, button, control } = setup(t, storage); assert.equal(control.theme, 'dark'); button.click(); assert.equal(root.dataset.theme, 'light'); button.click(); assert.equal(control.theme, 'dark');
  }
});

test('light palette has non-white surfaces and readable text / code token contrast', t => {
  const { document, window, button, root } = setup(t); button.click();
  const style = window.getComputedStyle(root), colors = Object.fromEntries(['bg', 'sidebar', 'surface', 'surface-raised', 'code', 'ink', 'muted', 'subtle'].map(key => [key, style.getPropertyValue('--' + key).trim()]));
  const luminance = hex => {
    const rgb = hex.replace('#', '').match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  for (const surface of ['bg', 'sidebar', 'surface', 'surface-raised', 'code']) {
    assert.match(colors[surface], /^#[a-f0-9]{6}$/); assert.notEqual(colors[surface], '#ffffff');
    for (const text of ['ink', 'muted', 'subtle']) assert.ok(contrast(colors[text], colors[surface]) >= 4.5, `${text} on ${surface} needs readable contrast`);
  }
  const lightRules = css.slice(css.indexOf('/* Warm gray'));
  for (const match of lightRules.matchAll(/\.syntax-([a-z]+) \{ color: (#[a-f0-9]{6}); \}/g)) for (const background of ['surface', 'code']) assert.ok(contrast(match[2], colors[background]) >= 4.5, `${match[1]} on ${background}`);
  // jsdom does not fully resolve inherited CSS variables. Inspect parsed rules;
  // this verifies the stylesheet contract, not browser layout or screenshots.
  const rules = [...document.styleSheets[0].cssRules];
  assert.equal(rules.find(rule => rule.selectorText === ':root[data-theme="light"] main').style.background, 'var(--bg)');
  assert.equal(rules.find(rule => rule.selectorText === '.sidebar').style.background, 'var(--sidebar)');
  assert.ok(rules.some(rule => rule.selectorText === ':root[data-theme="light"] .editor-pane:not(.has-highlight) #fileEditorText'), 'plain-text color must not cover the transparent syntax overlay');
});


test('appearance rollback is immediate, persisted and preserves the editor, drafts and light/dark preference', t => {
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const page = setup(t, storage), select = page.document.getElementById('appearanceSelect');
  const control = createAppearanceControl({ root: page.root, select, storage });
  const input = page.document.getElementById('fileEditorText'), prompt = page.document.getElementById('prompt');
  input.value = 'unsaved content'; input.setSelectionRange(2, 8); input.scrollTop = 96; prompt.value = 'unsent message';
  assert.equal(control.appearance, 'neon');
  page.button.click(); assert.equal(page.control.theme, 'light');
  select.value = 'classic'; select.dispatchEvent(new page.window.Event('change'));
  assert.equal(page.root.dataset.appearance, 'classic'); assert.equal(saved.get('lemon:appearance'), 'classic');
  assert.equal(page.root.dataset.theme, 'light'); assert.equal(page.document.getElementById('fileEditorText'), input);
  assert.equal(input.value, 'unsaved content'); assert.equal(input.selectionStart, 2); assert.equal(input.scrollTop, 96); assert.equal(prompt.value, 'unsent message');
  const restored = setup(t, storage), next = createAppearanceControl({ root: restored.root, select: restored.document.getElementById('appearanceSelect'), storage });
  assert.equal(next.appearance, 'classic'); assert.equal(restored.control.theme, 'light');
  select.value = 'neon'; select.dispatchEvent(new page.window.Event('change')); assert.equal(control.appearance, 'neon'); assert.equal(input.value, 'unsaved content');
});

test('appearance switch remains usable when browser storage is unavailable', t => {
  const page = setup(t), select = page.document.getElementById('appearanceSelect');
  const control = createAppearanceControl({ root: page.root, select, storage: { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Quota'); } } });
  select.value = 'classic'; select.dispatchEvent(new page.window.Event('change')); assert.equal(control.appearance, 'classic');
});

test('gallery switches every skin without replacing drafts, restores selection and keeps both controls synchronized', t => {
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const page = setup(t, storage), doc = page.document, select = doc.getElementById('appearanceSelect');
  createAppearanceControl({ root: page.root, select, storage });
  const editor = doc.getElementById('fileEditorText'); editor.value = 'unsaved SQL'; editor.setSelectionRange(3, 7);
  doc.getElementById('prompt').value = 'unsent task';
  const cards = [...doc.querySelectorAll('[data-appearance-choice]')]; assert.equal(cards.length, 6);
  for (const card of cards) {
    card.click(); const value = card.dataset.appearanceChoice;
    assert.equal(page.root.dataset.appearance, value); assert.equal(select.value, value); assert.equal(saved.get('lemon:appearance'), value);
    assert.equal(page.root.dataset.skin, value === 'classic' ? 'classic' : 'modern');
    assert.equal(doc.querySelectorAll('[data-appearance-choice][aria-pressed=true]').length, 1);
    assert.equal(doc.getElementById('fileEditorText'), editor); assert.equal(editor.value, 'unsaved SQL'); assert.equal(editor.selectionStart, 3);
    assert.equal(doc.getElementById('prompt').value, 'unsent task');
    const restored = setup(t, storage);
    assert.equal(createAppearanceControl({ root: restored.root, select: restored.document.getElementById('appearanceSelect'), storage }).appearance, value);
  }
  doc.querySelector('[data-color-mode=light]').click(); assert.equal(page.control.theme, 'light');
  doc.querySelector('[data-color-mode=light]').click(); assert.equal(page.control.theme, 'light');
  page.button.click(); assert.equal(doc.querySelector('[data-color-mode=dark]').getAttribute('aria-pressed'), 'true');
  select.value = 'aurora'; select.dispatchEvent(new page.window.Event('change'));
  assert.equal(doc.querySelector('[data-appearance-choice=aurora]').getAttribute('aria-pressed'), 'true');
});

test('gallery closes with Escape, outside click and keyboard exit; invalid saved styles fall back to the current skin', t => {
  const page = setup(t), doc = page.document;
  const control = createAppearanceControl({ root: page.root, select: doc.getElementById('appearanceSelect'), storage: { getItem: () => 'removed-skin', setItem() {} } });
  assert.equal(control.appearance, 'neon');
  const trigger = doc.getElementById('appearanceToggle'), panel = doc.getElementById('appearancePanel');
  trigger.click(); assert.equal(panel.hidden, false); assert.equal(doc.activeElement.dataset.appearanceChoice, 'neon');
  doc.activeElement.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.hidden, true); assert.equal(doc.activeElement, trigger); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  trigger.click(); doc.body.dispatchEvent(new page.window.Event('pointerdown', { bubbles: true })); assert.equal(panel.hidden, true);
  trigger.click(); doc.getElementById('prompt').focus(); assert.equal(panel.hidden, true);
});

test('module themes isolate palettes and edits, survive global mode and skin changes, and restore on reload', t => {
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const page = setup(t, storage), { document: doc, root, window } = page;
  createAppearanceControl({ root, select: doc.getElementById('appearanceSelect'), storage });
  const modules = createModuleThemeControls({ root, storage });
  t.after(() => modules.dispose());
  const editor = doc.getElementById('fileEditor'), input = doc.getElementById('fileEditorText'), chat = doc.getElementById('mainPanel');
  input.value = 'unsaved content'; input.setSelectionRange(2, 6); input.scrollTop = 88;
  doc.getElementById('prompt').value = 'unsent task';
  const toggle = doc.querySelector('[data-module-theme-toggle=editor]');
  toggle.click(); assert.equal(editor.dataset.theme, 'light'); assert.equal(chat.dataset.theme, 'dark'); assert.equal(root.dataset.theme, 'dark');
  assert.equal(doc.getElementById('sidebar').hasAttribute('data-module-theme'), false);
  assert.equal(window.getComputedStyle(editor).getPropertyValue('--code').trim(), '#e5ebf2');
  page.button.click(); assert.equal(editor.dataset.theme, 'light'); assert.equal(chat.dataset.theme, 'light');
  toggle.click(); assert.equal(editor.dataset.theme, 'dark'); assert.equal(chat.dataset.theme, 'light');
  assert.equal(window.getComputedStyle(editor).getPropertyValue('--code').trim(), '#0e1419');
  for (const card of doc.querySelectorAll('[data-appearance-choice]')) {
    card.click(); assert.equal(editor.dataset.appearance, root.dataset.appearance); assert.equal(editor.dataset.theme, 'dark');
  }
  assert.equal(doc.getElementById('fileEditorText'), input); assert.equal(input.value, 'unsaved content'); assert.equal(input.selectionStart, 2); assert.equal(input.scrollTop, 88);
  assert.equal(doc.getElementById('prompt').value, 'unsent task');
  assert.deepEqual(JSON.parse(saved.get('lemon:moduleThemes')), { editor: 'dark' });
  const next = setup(t, storage);
  const restored = createModuleThemeControls({ root: next.root, storage }); t.after(() => restored.dispose());
  assert.equal(next.root.dataset.theme, 'light'); assert.equal(next.document.getElementById('fileEditor').dataset.theme, 'dark');
});

test('module theme choices tolerate invalid data and blocked storage', t => {
  for (const storage of [{ getItem: () => '{broken', setItem() {} }, { getItem: () => '{"editor":"blue","chat":"light","unknown":"dark"}', setItem() {} }, { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Quota'); } }]) {
    const page = setup(t), modules = createModuleThemeControls({ root: page.root, storage }); t.after(() => modules.dispose());
    assert.equal(modules.mode('editor'), 'dark');
    const toggle = page.document.querySelector('[data-module-theme-toggle=editor]'); toggle.click(); assert.equal(modules.mode('editor'), 'light'); toggle.click(); assert.equal(modules.mode('editor'), 'dark');
  }
});
