/**
 * Shared React primitives and the base stylesheet for the reading page.
 *
 * Everything here is hand-written against host theme tokens (`--dsw-alias-*`) and
 * host geometry conventions; the plugin does not import host UI packages.
 */

const RD_ICONS = {
  book: 'M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Zm16 0A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5v-13Z',
  back: 'M15 5l-7 7 7 7',
  toc: 'M4 6h16M4 12h10M4 18h13',
  note: 'M6 3h9l5 5v13H6V3Zm8 1v5h5',
  bookmark: 'M7 3h10v18l-5-4-5 4V3Z',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8 3.5-1.9-.6a6.6 6.6 0 0 0-.6-1.5l1-1.7-1.5-1.5-1.7 1a6.6 6.6 0 0 0-1.5-.6L13 4h-2l-.6 1.9a6.6 6.6 0 0 0-1.5.6l-1.7-1L5.7 7l1 1.7a6.6 6.6 0 0 0-.6 1.5L4 12v2l1.9.6a6.6 6.6 0 0 0 .6 1.5l-1 1.7 1.5 1.5 1.7-1a6.6 6.6 0 0 0 1.5.6L11 20h2l.6-1.9a6.6 6.6 0 0 0 1.5-.6l1.7 1 1.5-1.5-1-1.7a6.6 6.6 0 0 0 .6-1.5L20 14v-2Z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 5 5',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M5 20h14',
  send: 'M4 20l17-8L4 4v6l11 2-11 2v6Z',
  sparkles: 'M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3Zm7 11 .9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  check: 'M5 12.5l4.5 4.5L19 7',
  edit: 'M4 20h4L20 8l-4-4L4 16v4Z',
  copy: 'M9 9V5h10v10h-4M5 9h10v10H5V9Z',
  quote: 'M7 7h4v4c0 3-1.5 4.5-4 5M14 7h4v4c0 3-1.5 4.5-4 5',
  arrowUp: 'M12 20V5m0 0-6 6m6-6 6 6',
  arrowDown: 'M12 4v15m0 0 6-6m-6 6-6-6',
  bookOpen: 'M12 5C9 3.7 6 3.5 3 4.4v14.2c3-.9 6-.7 9 .6 3-1.3 6-1.5 9-.6V4.4c-3-.9-6-.7-9 .6Zm0 0v14.8',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M5 16v4h14v-4',
  refresh: 'M4 12a8 8 0 0 1 13.7-5.7L20 8m0-4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16m0 4v-4h4',
}

/** Render one stroked icon from the shared set. */
function Icon({ name, size = 16, className, style }) {
  const path = RD_ICONS[name] || RD_ICONS.book
  return h(
    'svg',
    {
      className: cx('rd-icon', className),
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: name === 'sparkles' ? 'currentColor' : 'none',
      stroke: name === 'sparkles' ? 'none' : 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style,
    },
    h('path', { d: path }),
  )
}

/** Standard text button. */
function Button({ variant = 'secondary', size = 'md', icon, children, onClick, disabled, title, type = 'button', className }) {
  return h(
    'button',
    {
      type,
      className: cx('rd-btn', `rd-btn-${variant}`, `rd-btn-${size}`, className),
      onClick,
      disabled,
      title,
    },
    icon ? h(Icon, { name: icon, size: size === 'sm' ? 14 : 16 }) : null,
    children ? h('span', { className: 'rd-btn-label' }, children) : null,
  )
}

/** Square icon-only button with an accessible name. */
function IconButton({ icon, label, onClick, active, disabled, size = 16, className, title }) {
  return h(
    'button',
    {
      type: 'button',
      className: cx('rd-icon-btn', active && 'is-active', className),
      onClick,
      disabled,
      title: title || label,
      'aria-label': label,
      'aria-pressed': active ? 'true' : undefined,
    },
    h(Icon, { name: icon, size }),
  )
}

/** Inline loading indicator. */
function Spinner({ size = 16 }) {
  return h('span', { className: 'rd-spinner', style: { width: size, height: size }, 'aria-hidden': true })
}

/** Centered empty state with an optional action. */
function Empty({ icon = 'book', title, description, action }) {
  return h(
    'div',
    { className: 'rd-empty' },
    h('div', { className: 'rd-empty-icon' }, h(Icon, { name: icon, size: 28 })),
    title ? h('div', { className: 'rd-empty-title' }, title) : null,
    description ? h('div', { className: 'rd-empty-desc' }, description) : null,
    action ? h('div', { className: 'rd-empty-action' }, action) : null,
  )
}

/** Modal dialog drawn inside the reading page root. */
function Dialog({ open, onClose, title, description, children, footer, width = 520 }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    const previous = document.activeElement
    const timer = setTimeout(() => {
      const focusable = ref.current?.querySelector('button, input, textarea, select, [tabindex]')
      focusable?.focus?.()
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus?.()
    }
  }, [open, onClose])
  if (!open) return null
  return h(
    'div',
    { className: 'rd-dialog-layer', role: 'presentation' },
    h('div', { className: 'rd-dialog-mask', onClick: onClose }),
    h(
      'div',
      { className: 'rd-dialog', style: { maxWidth: width }, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, ref },
      h(
        'div',
        { className: 'rd-dialog-head' },
        h('div', { className: 'rd-dialog-title' }, title),
        description ? h('div', { className: 'rd-dialog-desc' }, description) : null,
        h(IconButton, { icon: 'close', label: t('common.close'), onClick: onClose }),
      ),
      h('div', { className: 'rd-dialog-body' }, children),
      footer ? h('div', { className: 'rd-dialog-foot' }, footer) : null,
    ),
  )
}

/** Labelled text field. */
function TextField({ label, value, onChange, placeholder, multiline, rows = 3, autoFocus, onKeyDown, hint, disabled, inputRef }) {
  const common = {
    className: 'rd-input',
    value,
    placeholder,
    onChange: (event) => onChange(event.target.value),
    autoFocus,
    onKeyDown,
    disabled,
  }
  return h(
    'label',
    { className: 'rd-field' },
    label ? h('span', { className: 'rd-field-label' }, label) : null,
    multiline ? h('textarea', { ...common, rows, ref: inputRef }) : h('input', { ...common, type: 'text', ref: inputRef }),
    hint ? h('span', { className: 'rd-field-hint' }, hint) : null,
  )
}

/** A row of mutually exclusive segmented choices. */
function Segmented({ value, options, onChange, label }) {
  return h(
    'div',
    { className: 'rd-segmented', role: 'group', 'aria-label': label },
    options.map((option) =>
      h(
        'button',
        {
          key: option.value,
          type: 'button',
          className: cx('rd-segmented-item', value === option.value && 'is-active'),
          onClick: () => onChange(option.value),
          'aria-pressed': value === option.value ? 'true' : undefined,
        },
        option.label,
      ),
    ),
  )
}

/** A slider row used by reading settings. */
function Slider({ label, value, min, max, step = 1, suffix, onChange }) {
  return h(
    'div',
    { className: 'rd-slider-row' },
    h('span', { className: 'rd-field-label' }, label),
    h('input', {
      className: 'rd-slider',
      type: 'range',
      min,
      max,
      step,
      value,
      onChange: (event) => onChange(Number(event.target.value)),
    }),
    h('span', { className: 'rd-slider-value' }, `${value}${suffix || ''}`),
  )
}

/** Render one line with inline `**bold**` and `` `code` `` spans. */
function renderInlineLine(line, keyPrefix) {
  const tokens = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) tokens.push(line.slice(last, match.index))
    const raw = match[0]
    if (raw.startsWith('**')) tokens.push(h('strong', { key: `${keyPrefix}-b${match.index}` }, raw.slice(2, -2)))
    else tokens.push(h('code', { key: `${keyPrefix}-c${match.index}`, className: 'rd-md-code' }, raw.slice(1, -1)))
    last = match.index + raw.length
  }
  if (last < line.length) tokens.push(line.slice(last))
  return tokens.length > 0 ? tokens : ['']
}

/** Minimal Markdown renderer for model answers and note bodies. */
function MarkdownText({ text, className }) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let list = null
  let paragraph = []
  const flushParagraph = (index) => {
    if (paragraph.length === 0) return
    blocks.push(h('p', { key: `p${index}` }, renderInlineLine(paragraph.join('\n'), `p${index}`)))
    paragraph = []
  }
  const flushList = (index) => {
    if (!list) return
    blocks.push(
      h(
        list.ordered ? 'ol' : 'ul',
        { key: `l${index}`, className: 'rd-md-list' },
        list.items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInlineLine(item, `l${index}-${itemIndex}`))),
      ),
    )
    list = null
  }
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '') {
      flushParagraph(index)
      flushList(index)
      return
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushParagraph(index)
      flushList(index)
      blocks.push(h('div', { key: `h${index}`, className: `rd-md-heading rd-md-h${heading[1].length}` }, renderInlineLine(heading[2], `h${index}`)))
      return
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed)
    if (bullet || numbered) {
      flushParagraph(index)
      const ordered = Boolean(numbered)
      if (!list || list.ordered !== ordered) {
        flushList(index)
        list = { ordered, items: [] }
      }
      list.items.push((bullet || numbered)[1])
      return
    }
    if (trimmed.startsWith('> ')) {
      flushParagraph(index)
      flushList(index)
      blocks.push(h('blockquote', { key: `q${index}`, className: 'rd-md-quote' }, renderInlineLine(trimmed.slice(2), `q${index}`)))
      return
    }
    if (trimmed.startsWith('```')) {
      flushParagraph(index)
      flushList(index)
      return
    }
    if (list) list.items.push(trimmed)
    else paragraph.push(line)
  })
  flushParagraph(lines.length)
  flushList(lines.length)
  return h('div', { className: cx('rd-md', className) }, blocks)
}

/** Inline notice used for errors inside surfaces. */
function Notice({ tone = 'info', children, action }) {
  return h(
    'div',
    { className: cx('rd-notice', `rd-notice-${tone}`) },
    h('div', { className: 'rd-notice-text' }, children),
    action ? h('div', { className: 'rd-notice-action' }, action) : null,
  )
}

/** Floating toast shown at the reading page's bottom edge. */
function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(onDismiss, toast.tone === 'error' ? 6000 : 3200)
    return () => clearTimeout(timer)
  }, [toast, onDismiss])
  if (!toast) return null
  return h(
    'div',
    { className: cx('rd-toast', toast.tone === 'error' && 'is-error'), role: 'status' },
    h(Icon, { name: toast.tone === 'error' ? 'close' : 'check', size: 14 }),
    h('span', null, toast.message),
  )
}

/** Simple progress bar. */
function Progress({ value, className }) {
  const percent = clamp(Math.round((Number(value) || 0) * 100), 0, 100)
  return h(
    'div',
    { className: cx('rd-progress', className), role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('div', { className: 'rd-progress-fill', style: { width: `${percent}%` } }),
  )
}

addStyles(`
.rd-root {
  --rd-radius-sm: 6px;
  --rd-radius-md: 10px;
  --rd-radius-lg: 14px;
  --rd-paper: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 86%, #efe3c8);
  --rd-paper-line: color-mix(in oklab, var(--dsw-alias-border-l1) 70%, #d8c8a8);
  position: relative;
  width: 100%;
  height: 100%;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.5;
}
.rd-root * { box-sizing: border-box; }
.rd-root ::selection { background: color-mix(in oklab, var(--dsw-alias-brand-primary) 28%, transparent); }

.rd-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 0 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  flex: none;
}
html[data-platform='darwin'] .rd-header { padding-top: var(--dsh-frame-top-clearance, 0px); }
.rd-header-title { font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.rd-header-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.rd-header-spacer { flex: 1; }
.rd-header-actions { display: flex; align-items: center; gap: 6px; }

.rd-tabs { display: flex; align-items: center; gap: 2px; padding: 0 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
.rd-tab { position: relative; border: 0; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; padding: 10px 10px 11px; cursor: pointer; }
.rd-tab:hover { color: var(--dsw-alias-label-primary); }
.rd-tab.is-active { color: var(--dsw-alias-label-primary); font-weight: 600; }
.rd-tab.is-active::after { content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }

.rd-body { flex: 1; min-height: 0; display: flex; overflow: hidden; position: relative; }
.rd-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.rd-page { padding: 28px clamp(24px, 4vw, 48px) 48px; max-width: 1040px; margin: 0 auto; width: 100%; }
@media (width <= 767px) { .rd-page { padding-inline: 20px; } }

.rd-btn {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: var(--rd-radius-sm);
  font: inherit; font-size: 13px; line-height: 1;
  padding: 0 12px; height: 30px; cursor: pointer;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
  white-space: nowrap;
}
.rd-btn:hover { background: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 82%, var(--dsw-alias-label-primary)); }
.rd-btn:disabled { opacity: .5; cursor: default; }
.rd-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.rd-btn-primary:hover { background: color-mix(in oklab, var(--dsw-alias-brand-primary) 86%, #000); }
.rd-btn-ghost { background: transparent; border-color: transparent; }
.rd-btn-ghost:hover { background: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 70%, var(--dsw-alias-label-primary)); }
.rd-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in oklab, var(--dsw-alias-state-error-primary) 40%, transparent); background: transparent; }
.rd-btn-sm { height: 26px; padding: 0 9px; font-size: 12px; }
.rd-btn-label { display: inline-block; }

.rd-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: var(--rd-radius-sm);
  border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; padding: 0;
}
.rd-icon-btn:hover { background: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 70%, var(--dsw-alias-label-primary)); color: var(--dsw-alias-label-primary); }
.rd-icon-btn.is-active { color: var(--dsw-alias-brand-primary); background: color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent); }
.rd-icon-btn:disabled { opacity: .45; cursor: default; }

.rd-input {
  width: 100%; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--rd-radius-sm); padding: 8px 10px; outline: none; resize: vertical;
}
.rd-input:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in oklab, var(--dsw-alias-brand-primary) 16%, transparent); }
.rd-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.rd-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); font-weight: 500; }
.rd-field-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }

.rd-segmented { display: inline-flex; padding: 2px; border-radius: var(--rd-radius-sm); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); gap: 2px; }
.rd-segmented-item { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
.rd-segmented-item.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.08); }

.rd-slider-row { display: grid; grid-template-columns: 72px 1fr 48px; align-items: center; gap: 10px; margin-bottom: 12px; }
.rd-slider { accent-color: var(--dsw-alias-brand-primary); width: 100%; }
.rd-slider-value { font-size: 12px; color: var(--dsw-alias-label-secondary); text-align: right; font-variant-numeric: tabular-nums; }

.rd-icon { flex: none; display: block; }
.rd-spinner {
  display: inline-block; border-radius: 50%;
  border: 2px solid color-mix(in oklab, var(--dsw-alias-label-secondary) 40%, transparent);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: rd-spin .7s linear infinite;
}
@keyframes rd-spin { to { transform: rotate(360deg); } }

.rd-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 64px 24px; text-align: center; color: var(--dsw-alias-label-secondary); }
.rd-empty-icon { width: 56px; height: 56px; border-radius: 16px; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.rd-empty-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.rd-empty-desc { font-size: 13px; max-width: 420px; line-height: 1.6; }
.rd-empty-action { margin-top: 6px; display: flex; gap: 8px; }

.rd-progress { height: 4px; border-radius: 999px; background: color-mix(in oklab, var(--dsw-alias-label-secondary) 18%, transparent); overflow: hidden; }
.rd-progress-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .3s ease; }

.rd-notice { display: flex; gap: 10px; align-items: flex-start; border-radius: var(--rd-radius-sm); padding: 9px 12px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.rd-notice-error { border-color: color-mix(in oklab, var(--dsw-alias-state-error-primary) 40%, transparent); color: var(--dsw-alias-state-error-primary); }
.rd-notice-warn { border-color: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 40%, transparent); color: var(--dsw-alias-state-warn-primary); }
.rd-notice-text { flex: 1; line-height: 1.55; }
.rd-notice-action { flex: none; }

.rd-dialog-layer { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; }
.rd-dialog-mask { position: absolute; inset: 0; background: rgba(0,0,0,.32); }
.rd-dialog { position: relative; width: calc(100% - 48px); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--rd-radius-lg); box-shadow: 0 16px 48px rgba(0,0,0,.24); max-height: calc(100% - 64px); display: flex; flex-direction: column; }
.rd-dialog-head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 16px 10px; }
.rd-dialog-title { font-size: 15px; font-weight: 600; flex: 1; }
.rd-dialog-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 0 16px 8px; }
.rd-dialog-body { padding: 4px 16px 12px; overflow: auto; }
.rd-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1); }

.rd-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 80; display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 999px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 8px 24px rgba(0,0,0,.18); font-size: 13px; }
.rd-toast.is-error { color: var(--dsw-alias-state-error-primary); }

.rd-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 12px 0; }
.rd-muted { color: var(--dsw-alias-label-secondary); }
.rd-mono { font-family: var(--dsh-font-family-mono, ui-monospace, monospace); }
`)
