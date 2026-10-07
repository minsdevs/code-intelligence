'use strict';

// Accessibility measurements for the real rendered renderer of a packaged app.
// No rule engine is installed in this repository, so each check is implemented
// directly: browser functions below are serialized into the page by Playwright
// and must stay self-contained; Node helpers summarize CDP accessibility trees.

// WCAG 2.1 relative luminance/contrast for 8-bit sRGB triples.
function relativeLuminance([r, g, b]) {
  const linear = value => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function contrastRatio(first, second) {
  const [high, low] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}
function requiredRatio(fontSizePx, fontWeight) {
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && Number(fontWeight) >= 700);
  return large ? 3 : 4.5;
}

// Runs inside the renderer. Returns DOM-derived measurements for one screen state.
function auditDom(options) {
  const opts = options || {};
  const state = (window.__uxAudit ||= { ids: new WeakMap(), next: 1 });
  const idOf = element => {
    let value = state.ids.get(element);
    if (!value) { value = state.next++; state.ids.set(element, value); }
    return value;
  };
  const clean = (value, length = 60) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, length);
  const describe = element => ({
    id: idOf(element), tag: element.localName, role: element.getAttribute('role'),
    name: clean(element.getAttribute('aria-label') || element.innerText || element.getAttribute('title')
      || element.getAttribute('placeholder') || element.value),
    className: clean(typeof element.className === 'string' ? element.className : element.getAttribute('class'), 80),
  });
  const shown = element => element.checkVisibility
    ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : Boolean(element.offsetWidth || element.offsetHeight);
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const paint = (layers, top, topAlpha = 1) => {
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1, 1);
    for (const layer of layers) { context.fillStyle = layer; context.fillRect(0, 0, 1, 1); }
    if (top) { context.globalAlpha = topAlpha; context.fillStyle = top; context.fillRect(0, 0, 1, 1); context.globalAlpha = 1; }
    const data = context.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]];
  };
  const hex = rgb => '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('');
  const luminance = ([r, g, b]) => {
    const linear = value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const chainOf = element => {
    const chain = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) chain.push(node);
    return chain.reverse();
  };
  const background = element => {
    const layers = [];
    let indeterminate = false, opacity = 1;
    for (const node of chainOf(element)) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== 'none') indeterminate = true;
      layers.push(style.backgroundColor);
      opacity *= Number(style.opacity);
    }
    return { layers, indeterminate, opacity };
  };
  const result = { url: location.pathname + location.search, lang: document.documentElement.lang, title: document.title,
    viewport: [innerWidth, innerHeight] };

  // Text contrast from actual computed colours, composited over ancestor backgrounds.
  const failures = new Map();
  let checked = 0, indeterminate = 0, exemptDisabled = 0, hangul = 0, latinOnly = 0;
  const otherLanguage = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT,
    { acceptNode: node => node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  while (walker.nextNode()) {
    const element = walker.currentNode.parentElement;
    if (!element || seen.has(element)) continue;
    seen.add(element);
    if (!shown(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const text = clean(element.innerText || element.textContent, 48);
    if (!text) continue;
    const code = Boolean(element.closest('.monaco-editor'));
    const literal = code || Boolean(element.closest('.font-mono, code, pre, [data-testid="code-viewer"]'));
    if (/[가-힣]/.test(text)) {
      hangul++;
      if (opts.lang === 'en' && !literal && otherLanguage.length < 25) otherLanguage.push(text);
    } else if (/[A-Za-z]{3,}/.test(text) && !/[\\/._:#@(){}]/.test(text)) {
      latinOnly++;
      if (opts.lang === 'ko' && !literal && otherLanguage.length < 25) otherLanguage.push(text);
    }
    if (element.closest(':disabled, [aria-disabled="true"]')) { exemptDisabled++; continue; }
    const style = getComputedStyle(element);
    const svg = element instanceof SVGElement;
    const foreground = svg ? style.fill : style.color;
    if (!foreground || foreground === 'none' || foreground.startsWith('url(')) { indeterminate++; continue; }
    const back = background(svg ? element.ownerSVGElement || element : element);
    if (svg) {
      const label = element.closest('.react-flow__edge-textwrapper')?.querySelector('.react-flow__edge-textbg');
      if (label) back.layers.push(getComputedStyle(label).fill);
    }
    if (back.indeterminate) indeterminate++;
    const bg = paint(back.layers);
    const fg = paint(back.layers, foreground, back.opacity);
    const value = ratio(fg, bg);
    const size = parseFloat(style.fontSize);
    const required = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    checked++;
    if (value + 1e-9 < required) {
      const key = `${hex(fg)}|${hex(bg)}|${required}|${code ? 'code' : 'ui'}`;
      const group = failures.get(key) || { foreground: hex(fg), background: hex(bg), required, ratio: value,
        category: code ? 'code-viewer' : 'ui', count: 0, samples: [], computedColor: foreground, fontSizesPx: [] };
      group.count++;
      group.ratio = Math.min(group.ratio, value);
      if (group.samples.length < 3) group.samples.push(text);
      if (!group.fontSizesPx.includes(size) && group.fontSizesPx.length < 4) group.fontSizesPx.push(size);
      failures.set(key, group);
    }
  }
  result.contrast = { checkedElements: checked, indeterminateBackground: indeterminate, exemptDisabled,
    failures: [...failures.values()].map(group => ({ ...group, ratio: Math.round(group.ratio * 100) / 100 }))
      .sort((a, b) => b.count - a.count) };
  result.language = { hangulTextElements: hangul, latinOnlyTextElements: latinOnly, otherLanguageSamples: otherLanguage };

  // Focusable elements in DOM order (sequential-navigation candidates).
  const focusable = [...document.querySelectorAll('a[href],area[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable="true"],[contenteditable=""]')]
    .filter(element => element.tabIndex >= 0 && !element.disabled && !element.closest('[inert]')
      && !(element.localName === 'input' && element.type === 'hidden') && !element.hasAttribute('data-ux-sentinel')
      && (shown(element) || element.classList.contains('inputarea') || element.closest('.monaco-editor')));
  result.focusables = focusable.map(describe);

  // Pointer affordances that are not reachable by keyboard.
  const pointerOnly = [];
  let scanned = 0;
  for (const element of document.querySelectorAll('body *')) {
    if (++scanned > 8000 || pointerOnly.length >= 25) break;
    if (element.closest('.monaco-editor')) continue;
    const style = getComputedStyle(element);
    if (style.cursor !== 'pointer' || !shown(element)) continue;
    const parent = element.parentElement;
    if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
    if (element.tabIndex >= 0 || element.closest('a[href],button,summary,label,select,input,textarea,[tabindex]:not([tabindex="-1"])')) continue;
    if (element.querySelector('a[href],button,summary,select,input,textarea,[tabindex]:not([tabindex="-1"])')) continue;
    pointerOnly.push(describe(element));
  }
  result.pointerOnly = pointerOnly;

  // Live regions present in this state.
  result.liveRegions = [...document.querySelectorAll('[role="status"],[role="alert"],[role="log"],[role="progressbar"],[aria-live],output')]
    .map(element => ({ role: element.getAttribute('role'), live: element.getAttribute('aria-live'), shown: shown(element),
      text: clean(element.textContent, 120) }));

  // Reflow/zoom: page-level horizontal scrolling, clipped text and unreachable off-screen text.
  const root = document.documentElement;
  const main = document.querySelector('main');
  const clipped = [], offscreen = [];
  let ellipsis = 0;
  for (const element of seen) {
    if (!shown(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const style = getComputedStyle(element);
    if (style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1) { ellipsis++; continue; }
    let scrollable = false;
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const ancestor = getComputedStyle(node);
      if (['auto', 'scroll'].includes(ancestor.overflowX)) { scrollable = true; break; }
      if (['hidden', 'clip'].includes(ancestor.overflowX)) {
        const box = node.getBoundingClientRect();
        if (rect.right > box.right + 2 || rect.left < box.left - 2) {
          if (clipped.length < 15) clipped.push({ ...describe(element), text: clean(element.innerText, 40), by: describe(node) });
          break;
        }
      }
    }
    if (!scrollable && (rect.right > innerWidth + 2 || rect.left < -2) && offscreen.length < 15) {
      offscreen.push({ ...describe(element), text: clean(element.innerText, 40) });
    }
  }
  result.reflow = { documentScrollWidth: Math.max(root.scrollWidth, document.body.scrollWidth), innerWidth,
    horizontalPageScroll: Math.max(root.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null, ellipsisTruncated: ellipsis, clipped, offscreen };

  // Motion that still runs (meaningful after emulating prefers-reduced-motion).
  const moving = [];
  const seconds = value => Math.max(0, ...String(value).split(',').map(part => parseFloat(part) * (part.trim().endsWith('ms') ? 0.001 : 1)).filter(Number.isFinite));
  for (const element of document.querySelectorAll('body *')) {
    if (moving.length >= 20) break;
    const style = getComputedStyle(element);
    const animated = style.animationName !== 'none' && seconds(style.animationDuration) > 0.01;
    const transition = seconds(style.transitionDuration) > 0.01;
    if ((animated || transition) && shown(element)) moving.push({ ...describe(element), animation: style.animationName, transition: style.transitionDuration });
  }
  result.motion = { reducedMotionQuery: matchMedia('(prefers-reduced-motion: reduce)').matches, moving };
  result.colorScheme = { dark: matchMedia('(prefers-color-scheme: dark)').matches, rootColorScheme: getComputedStyle(root).colorScheme,
    bodyBackground: hex(paint(background(document.body).layers)) };
  return result;
}

// Runs inside the renderer after each Tab press: the focused element and its indicator.
function activeElementState() {
  const state = (window.__uxAudit ||= { ids: new WeakMap(), next: 1 });
  const element = document.activeElement;
  if (!element || element === document.body || element === document.documentElement) return { body: true };
  if (element.hasAttribute('data-ux-sentinel')) return { sentinel: true };
  let id = state.ids.get(element);
  if (!id) { id = state.next++; state.ids.set(element, id); }
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const monaco = Boolean(element.closest('.monaco-editor'));
  const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
  const shadow = style.boxShadow && style.boxShadow !== 'none';
  let ringRatio = null;
  if (outline) {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const chain = [];
    for (let node = element.parentElement; node && node.nodeType === 1; node = node.parentElement) chain.push(node);
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1, 1);
    for (const node of chain.reverse()) { context.fillStyle = getComputedStyle(node).backgroundColor; context.fillRect(0, 0, 1, 1); }
    const bg = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    context.fillStyle = style.outlineColor; context.fillRect(0, 0, 1, 1);
    const ring = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    const lum = ([r, g, b]) => { const f = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const [x, y] = [lum(ring), lum(bg)].sort((p, q) => q - p);
    ringRatio = Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
  }
  return { id, tag: element.localName, role: element.getAttribute('role'),
    name: String(element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || element.value || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    focusVisible: element.matches(':focus-visible'), indicator: outline || Boolean(shadow) || monaco, monaco,
    outline: outline ? `${style.outlineWidth} ${style.outlineStyle}` : null, ringRatio,
    inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    size: [Math.round(rect.width), Math.round(rect.height)] };
}

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio',
  'switch', 'tab', 'treeitem', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'DisclosureTriangle']);
const LANDMARK_ROLES = new Set(['main', 'navigation', 'complementary', 'banner', 'contentinfo', 'region', 'form', 'search']);
const SEMANTICLESS_FOCUS = new Set(['generic', 'none', 'presentation', 'StaticText', 'paragraph', 'LabelText', 'Section', 'group']);
const STATE_PROPERTIES = ['pressed', 'expanded', 'selected', 'checked', 'disabled', 'invalid', 'busy', 'live', 'modal'];

// Summarizes a CDP Accessibility.getFullAXTree result (Node side, unit-tested).
function summarizeAxTree(nodes) {
  const value = field => (field && Object.hasOwn(field, 'value') ? field.value : undefined);
  const roles = {}, unnamed = [], semanticless = [], headings = [], landmarks = [], interactive = [], states = {};
  for (const node of nodes || []) {
    if (node.ignored) continue;
    const role = value(node.role);
    const name = String(value(node.name) ?? '').replace(/\s+/g, ' ').trim();
    const properties = Object.fromEntries((node.properties || []).map(property => [property.name, value(property.value)]));
    roles[role] = (roles[role] || 0) + 1;
    for (const key of STATE_PROPERTIES) if (properties[key] !== undefined && properties[key] !== false) states[key] = (states[key] || 0) + 1;
    if (INTERACTIVE_ROLES.has(role)) {
      if (interactive.length < 120) interactive.push({ role, name: name.slice(0, 70), ...(properties.focusable === false ? { notFocusable: true } : {}) });
      if (!name) unnamed.push({ role, backendDOMNodeId: node.backendDOMNodeId ?? null });
    }
    if (properties.focusable === true && SEMANTICLESS_FOCUS.has(role) && !properties.editable) {
      semanticless.push({ role, name: name.slice(0, 70), backendDOMNodeId: node.backendDOMNodeId ?? null });
    }
    if (role === 'heading') headings.push({ level: properties.level ?? null, name: name.slice(0, 70) });
    if (LANDMARK_ROLES.has(role) && (role !== 'region' || name)) landmarks.push({ role, name: name.slice(0, 70) });
  }
  const levels = headings.map(heading => heading.level).filter(Number.isInteger);
  const skipped = levels.some((level, index) => index > 0 && level > levels[index - 1] + 1);
  return { roles, unnamedInteractive: unnamed, focusableWithoutRole: semanticless, headings, landmarks,
    mainCount: landmarks.filter(entry => entry.role === 'main').length, hasH1: levels.includes(1), skippedHeadingLevel: skipped,
    interactive, states };
}

// Compares a recorded Tab sequence with the DOM focusables of the same state.
function summarizeTraversal(sequence, focusables, { trap = null, wrapped = false, limitReached = false } = {}) {
  const reached = new Set(sequence.map(entry => entry.id));
  const unreached = focusables.filter(entry => !reached.has(entry.id));
  const noIndicator = sequence.filter(entry => !entry.indicator);
  const lowRing = sequence.filter(entry => entry.ringRatio != null && entry.ringRatio < 3);
  const offscreen = sequence.filter(entry => !entry.inViewport);
  return { tabStops: sequence.length, domFocusables: focusables.length, unreached: unreached.slice(0, 20),
    unreachedCount: unreached.length, noVisibleIndicator: noIndicator.slice(0, 20), noVisibleIndicatorCount: noIndicator.length,
    lowContrastRing: lowRing.slice(0, 10), focusedOffscreenCount: offscreen.length, trap, wrapped, limitReached };
}

module.exports = { relativeLuminance, contrastRatio, requiredRatio, auditDom, activeElementState, summarizeAxTree,
  summarizeTraversal, INTERACTIVE_ROLES };
