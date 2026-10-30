// Tiny DOM builder used by every UI panel.
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, any> & { class?: string; style?: string; on?: Record<string, (e: any) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
      else if (k === 'class') el.className = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }

export function replace(el: Element, ...children: Child[]): void { clear(el); append(el, children); }

/** Modal panel with a header, close button and body. Returns { root, body, close }. */
export function modal(title: string, opts: { tag?: string; size?: 'wide' | 'narrow'; onClose?: () => void; closable?: boolean } = {}) {
  const body = h('div', { class: 'panel-body' });
  const wrap = h('div', { class: 'modal-wrap' });
  const close = () => { wrap.remove(); opts.onClose?.(); };
  const panel = h('div', { class: `panel modal ${opts.size ?? ''}`, role: 'dialog', 'aria-label': title },
    h('div', { class: 'panel-head' },
      h('h2', null, title),
      opts.tag ? h('span', { class: 'tag' }, opts.tag) : null,
      h('div', { class: 'spacer' }),
      opts.closable === false ? null : h('button', { class: 'close-x', 'aria-label': 'Close', on: { click: close } }, '×'),
    ),
    body,
  );
  wrap.appendChild(panel);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap && opts.closable !== false) close(); });
  return { root: wrap, body, panel, close };
}

export const fmtTime = (s: number) => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
export const fmtMoney = (n: number) => `$${n.toLocaleString('en-US')}`;
