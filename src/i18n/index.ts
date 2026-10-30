// Runtime localisation (English / 繁體中文 / 日本語).
// The UI is authored in English. A MutationObserver translates every text node and the
// placeholder/title/aria-label attributes under <body> as they appear, using an exact-match
// dictionary plus patterns for messages that embed values (many come from the host over the
// network, so they cannot be pre-translated by the sender). The English source of each node is
// remembered, so switching language re-translates the live page in place.
import { DICT, PATTERNS } from './strings';

export type Lang = 'en' | 'zh' | 'ja';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'EN' },
  { id: 'zh', label: '中文' },
  { id: 'ja', label: '日本語' },
];

let lang: Lang = 'en';
const listeners = new Set<(l: Lang) => void>();
/** English source + the text we last wrote, so app updates and language switches are told apart. */
const sourceText = new WeakMap<Text, { src: string; out: string }>();
const sourceAttr = new WeakMap<Element, Record<string, { src: string; out: string }>>();
const ATTRS = ['placeholder', 'title', 'aria-label'];
const IDX: Record<Exclude<Lang, 'en'>, 0 | 1> = { zh: 0, ja: 1 };

export function detectLang(): Lang {
  const n = (navigator.language || 'en').toLowerCase();
  if (n.startsWith('zh')) return 'zh';
  if (n.startsWith('ja')) return 'ja';
  return 'en';
}

export function getLang(): Lang { return lang; }

/** Translate an English UI string (optionally with {vars}). */
export function t(src: string, vars?: Record<string, string | number>): string {
  let out = translate(src);
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

export function translate(src: string): string {
  if (lang === 'en' || !src) return src;
  const i = IDX[lang];
  const exact = DICT[src];
  if (exact) return exact[i];
  const trimmed = src.trim();
  if (trimmed !== src) {
    const e2 = DICT[trimmed];
    if (e2) return src.replace(trimmed, e2[i]);
  }
  for (const [re, zh, ja] of PATTERNS) {
    const m = trimmed.match(re);
    if (m) {
      const tpl = i === 0 ? zh : ja;
      const rep = tpl.replace(/\$\$|\$(\d)/g, (_, d) => (d ? translate(m[Number(d)] ?? '') : '$'));
      return src.replace(trimmed, rep);
    }
  }
  return src;
}

function translateNode(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const tn = node as Text;
    const parent = tn.parentElement;
    if (!parent || parent.closest('[data-no-i18n], textarea, script, style')) return;
    const current = tn.data;
    const rec = sourceText.get(tn);
    // anything other than what we last wrote means the app set new (English) text
    const src = rec && current === rec.out ? rec.src : current;
    const next = translate(src);
    sourceText.set(tn, { src, out: next });
    if (next !== current) tn.data = next;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (el.closest('[data-no-i18n], textarea, script, style')) return;
  let attrs = sourceAttr.get(el);
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v === null) continue;
    if (!attrs) sourceAttr.set(el, (attrs = {}));
    const rec = attrs[a];
    const src = rec && v === rec.out ? rec.src : v;
    const next = translate(src);
    attrs[a] = { src, out: next };
    if (next !== v) el.setAttribute(a, next);
  }
  for (const c of Array.from(el.childNodes)) translateNode(c);
}

let observer: MutationObserver | null = null;
export function startTranslator(): void {
  if (observer) return;
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') translateNode(m.target);
      else if (m.type === 'attributes') translateNode(m.target);
      else m.addedNodes.forEach((n) => translateNode(n));
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  translateNode(document.body);
}

export function setLang(l: Lang): void {
  lang = l;
  document.documentElement.lang = l === 'zh' ? 'zh-Hant' : l === 'ja' ? 'ja' : 'en';
  document.body.dataset.lang = l;
  if (observer) translateNode(document.body);
  for (const fn of listeners) fn(l);
}

export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
