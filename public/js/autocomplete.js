// Lightweight, keyboard-accessible autocomplete for the country input.
// Prefix matches rank above substring matches; Enter accepts the highlighted
// item (or the single match), and onSubmit fires with the chosen name.

import { normalizeName } from './normalize.js';

const MAX_RESULTS = 7;

export class Autocomplete {
  /**
   * @param {object} opts
   * @param {HTMLInputElement} opts.input
   * @param {HTMLElement} opts.list      <ul> container for suggestions
   * @param {string[]} opts.names        candidate country names
   * @param {(name: string) => void} opts.onSubmit
   */
  constructor({ input, list, names, onSubmit }) {
    this.input = input;
    this.list = list;
    this.onSubmit = onSubmit;
    this.activeIndex = -1;
    this.matches = [];
    this.setNames(names);

    input.addEventListener('input', () => this.refresh());
    input.addEventListener('keydown', (e) => this.onKeyDown(e));
    input.addEventListener('focus', () => {
      if (input.value.trim()) this.refresh();
    });
    document.addEventListener('click', (e) => {
      if (!this.list.contains(e.target) && e.target !== this.input) this.close();
    });
  }

  setNames(names) {
    this.names = names || [];
    this.normalized = this.names.map((n) => ({ name: n, key: normalizeName(n) }));
  }

  /** Compute matches for the current input value. */
  compute(value) {
    const q = normalizeName(value);
    if (!q) return [];
    const prefix = [];
    const inner = [];
    for (const item of this.normalized) {
      const idx = item.key.indexOf(q);
      if (idx === 0) prefix.push(item.name);
      else if (idx > 0) inner.push(item.name);
    }
    return [...prefix, ...inner].slice(0, MAX_RESULTS);
  }

  refresh() {
    this.matches = this.compute(this.input.value);
    this.activeIndex = this.matches.length ? 0 : -1;
    this.render();
  }

  render() {
    const q = normalizeName(this.input.value);
    this.list.innerHTML = '';
    if (!this.matches.length) {
      this.close();
      return;
    }
    this.matches.forEach((name, i) => {
      const li = document.createElement('li');
      li.className = 'ac-item' + (i === this.activeIndex ? ' active' : '');
      li.id = `ac-item-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === this.activeIndex ? 'true' : 'false');
      li.innerHTML = highlight(name, q);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus on input
        this.choose(name);
      });
      li.addEventListener('mouseenter', () => {
        this.activeIndex = i;
        this.syncActive();
      });
      this.list.appendChild(li);
    });
    this.open();
  }

  syncActive() {
    [...this.list.children].forEach((li, i) => {
      const active = i === this.activeIndex;
      li.classList.toggle('active', active);
      li.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const el = this.list.children[this.activeIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  onKeyDown(e) {
    const open = this.list.classList.contains('open');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) return this.refresh();
      this.activeIndex = Math.min(this.activeIndex + 1, this.matches.length - 1);
      this.syncActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeIndex = Math.max(this.activeIndex - 1, 0);
      this.syncActive();
    } else if (e.key === 'Enter') {
      // If a suggestion is highlighted, take it; otherwise submit raw text.
      if (open && this.activeIndex >= 0 && this.matches[this.activeIndex]) {
        e.preventDefault();
        this.choose(this.matches[this.activeIndex]);
      }
      // else: let the form submit with the typed value
    } else if (e.key === 'Escape') {
      this.close();
    } else if (e.key === 'Tab') {
      if (open && this.activeIndex >= 0) {
        e.preventDefault();
        this.input.value = this.matches[this.activeIndex];
        this.close();
      }
    }
  }

  choose(name) {
    this.input.value = name;
    this.close();
    this.onSubmit(name);
  }

  open() {
    this.list.classList.add('open');
    this.input.setAttribute('aria-expanded', 'true');
    if (this.activeIndex >= 0) this.input.setAttribute('aria-activedescendant', `ac-item-${this.activeIndex}`);
  }

  close() {
    this.list.classList.remove('open');
    this.list.innerHTML = '';
    this.activeIndex = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }
}

/** Bold the matched substring within a suggestion label. */
function highlight(name, q) {
  if (!q) return escapeHtml(name);
  const key = normalizeName(name);
  const idx = key.indexOf(q);
  if (idx < 0) return escapeHtml(name);
  // Map normalized index back to original string approximately by walking chars.
  // Since normalization can change length, fall back to a simple case-insensitive
  // highlight on the raw name when lengths differ.
  const raw = name.toLowerCase();
  const rawIdx = raw.indexOf(q);
  if (rawIdx >= 0) {
    return (
      escapeHtml(name.slice(0, rawIdx)) +
      '<span class="match">' +
      escapeHtml(name.slice(rawIdx, rawIdx + q.length)) +
      '</span>' +
      escapeHtml(name.slice(rawIdx + q.length))
    );
  }
  return escapeHtml(name);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
