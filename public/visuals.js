// Deterministic template layout: no image model, remote assets, or discarded copy.
import { sanitizeExport } from './export-safety.js';
export const VISUAL_PAGE_WIDTH = 1242;
export const VISUAL_PAGE_HEIGHT = 1660;
export const VISUAL_CONTENT_BOTTOM = 1420;
const LEFT = 92;
const CONTENT_WIDTH = VISUAL_PAGE_WIDTH - LEFT * 2;
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const xml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function graphemeWidth(value) {
  if (/^[\r\n]+$/.test(value)) return 0;
  if (value === '\t') return 1.3;
  if (/^\s+$/.test(value)) return 0.33;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)) return 1.12;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) return 1;
  if (/^[\u3000-\u303f\uff00-\uffef]/u.test(value)) return 1;
  if (/^[MW@%&#]/.test(value)) return 0.92;
  if (/^[ilI1.,:;'!|`]/.test(value)) return 0.31;
  if (/^[A-Z0-9]/.test(value)) return 0.65;
  if (/^[a-z]/.test(value)) return 0.55;
  return 0.7;
}

export function measureVisualText(value, fontSize = 42) {
  return [...segmenter.segment(String(value ?? ''))].reduce((sum, item) => sum + graphemeWidth(item.segment) * fontSize, 0);
}

// raw preserves every source character, including whitespace and paragraph breaks.
export function wrapVisualText(value, width = CONTENT_WIDTH, fontSize = 42) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(fontSize) || fontSize <= 0) throw new Error('图文排版尺寸必须为正数。');
  const characters = [...segmenter.segment(String(value ?? ''))].map(item => item.segment);
  const lines = [];
  let current = [], currentWidth = 0;
  const push = (extra = '') => {
    const text = current.join('');
    lines.push({ text, raw: text + extra, width: currentWidth });
    current = []; currentWidth = 0;
  };
  for (const character of characters) {
    if (/^[\r\n]+$/.test(character)) { push(character); continue; }
    const advance = graphemeWidth(character) * fontSize;
    if (current.length && currentWidth + advance > width) {
      // Keep ordinary English words together when there is a useful earlier space.
      const split = current.findLastIndex(char => /\s/.test(char));
      if (/^[A-Za-z]/.test(character) && split > 0 && split >= current.length * 0.4) {
        const carry = current.slice(split + 1);
        current = current.slice(0, split + 1);
        currentWidth = measureVisualText(current.join(''), fontSize);
        push();
        current = carry;
        currentWidth = measureVisualText(carry.join(''), fontSize);
      } else push();
    }
    current.push(character); currentWidth += advance;
  }
  if (current.length) push();
  return lines;
}

export function visualTextLines(value, width = 22) {
  return wrapVisualText(value, width, 1).map(line => line.text);
}

function paginateSection({ kind, heading, text, tags = '', sourcePage }) {
  const cover = kind === 'cover';
  const styles = {
    heading: { size: cover ? 88 : 62, lineHeight: cover ? 119 : 89, weight: 650, family: 'Songti SC, Noto Serif SC, serif' },
    body: { size: cover ? 39 : 42, lineHeight: cover ? 65 : 70, weight: 400, family: 'PingFang SC, Noto Sans SC, sans-serif' },
    tags: { size: 30, lineHeight: 49, weight: 400, family: 'PingFang SC, Noto Sans SC, sans-serif' },
  };
  const blocks = [{ role: 'heading', text: heading }, { role: 'body', text }, { role: 'tags', text: tags }].filter(block => block.text !== '');
  const prepared = blocks.map(block => ({ ...block, lines: wrapVisualText(block.text, CONTENT_WIDTH, styles[block.role].size) }));
  const headingHeight = (prepared.find(block => block.role === 'heading')?.lines.length || 0) * styles.heading.lineHeight;
  let lines = [], cursor = cover && headingHeight <= 4 * styles.heading.lineHeight ? 402 : 278;
  const pages = [];
  const flush = () => {
    if (!lines.length) return;
    pages.push({ kind, sourcePage, lines, heading: lines.filter(line => line.role === 'heading').map(line => line.raw).join(''), text: lines.filter(line => line.role === 'body').map(line => line.raw).join('') });
    lines = []; cursor = 278;
  };
  for (const block of prepared) {
    const style = styles[block.role];
    if (lines.length) cursor += block.role === 'tags' ? 42 : 38;
    for (const sourceLine of block.lines) {
      if (cursor + style.size > VISUAL_CONTENT_BOTTOM) flush();
      const y = cursor + style.size * 0.82;
      lines.push({ ...sourceLine, ...style, role: block.role, x: LEFT, y, renderWidth: Math.min(CONTENT_WIDTH, sourceLine.width), bottom: cursor + style.size });
      cursor += style.lineHeight;
    }
  }
  flush();
  // Empty source copy remains empty; a template never fabricates missing copy.
  if (!pages.length) pages.push({ kind, sourcePage, lines: [], heading: '', text: '' });
  return pages.map((page, index) => ({ ...page, part: index + 1, parts: pages.length, layoutVersion: 2 }));
}

export function visualAssets(draft) {
  draft = sanitizeExport(draft);
  const title = String(draft.title ?? '');
  const heading = String(draft.cover || title);
  const pages = Array.isArray(draft.pages) && draft.pages.length
    ? draft.pages
    : draft.body ? [{ heading: '', text: String(draft.body) }] : [];
  const tags = (draft.tags || []).map(tag => String(tag).startsWith('#') ? String(tag) : `#${tag}`).join('  ');
  const assets = paginateSection({ kind: 'cover', heading, text: heading === title ? '' : title, tags: pages.length ? '' : tags, sourcePage: 0 });
  pages.forEach((page, index) => assets.push(...paginateSection({ kind: 'page', heading: String(page.heading ?? ''), text: String(page.text ?? ''), tags: index === pages.length - 1 ? tags : '', sourcePage: index + 1 })));
  return assets;
}

export function visualSvg(draft, asset, index = 0, total = 1) {
  draft = sanitizeExport(draft);
  asset = sanitizeExport(asset);
  if (asset?.layoutVersion !== 2 || !Array.isArray(asset.lines)) throw new Error('图文素材需要先通过完整分页排版，请重新打开稿件后下载。');
  const cover = asset.kind === 'cover';
  const color = cover ? { bg: '#de4314', line: '#f9986f', ink: '#fffaf2', body: '#ffe7d5', muted: '#ffd2b8' } : { bg: '#fffaf2', line: '#ded1c0', ink: '#292822', body: '#514c43', muted: '#926c50' };
  const sectionLabel = cover ? '封面' : `图文 ${String(asset.sourcePage).padStart(2, '0')}`;
  const pageLabel = `${sectionLabel}${asset.parts > 1 ? ` · ${asset.part}/${asset.parts}` : ''}`;
  const text = asset.lines.map(line => {
    const fill = line.role === 'heading' ? color.ink : line.role === 'tags' ? color.muted : color.body;
    // Explicit per-line length prevents font fallback from overflowing the content box.
    const sizing = line.text.trim() ? ` textLength="${line.renderWidth.toFixed(2)}" lengthAdjust="spacingAndGlyphs"` : '';
    return `<text data-role="${line.role}" x="${line.x}" y="${line.y.toFixed(2)}" font-family="${line.family}" font-size="${line.size}" font-weight="${line.weight}" fill="${fill}" xml:space="preserve"${sizing}>${xml(line.text)}</text>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VISUAL_PAGE_WIDTH}" height="${VISUAL_PAGE_HEIGHT}" viewBox="0 0 ${VISUAL_PAGE_WIDTH} ${VISUAL_PAGE_HEIGHT}" role="img" aria-labelledby="visual-title visual-description">
<title id="visual-title">${xml(draft.title || '图文素材')} · ${xml(pageLabel)}</title>
<desc id="visual-description">由已有文案进行模板排版，非AI生成图片。完整文案自动分页，发布前需人工核验。</desc>
<rect width="1242" height="1660" fill="${color.bg}"/>
<rect x="58" y="58" width="1126" height="1544" fill="none" stroke="${color.line}" stroke-width="2"/>
<rect x="92" y="104" width="66" height="8" rx="4" fill="${cover ? color.ink : '#de4314'}"/>
<text x="92" y="177" font-family="PingFang SC, Noto Sans SC, sans-serif" font-size="25" fill="${color.muted}">${xml(pageLabel)}</text>
<text x="1150" y="177" text-anchor="end" font-family="ui-monospace, monospace" font-size="25" fill="${color.muted}">${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</text>
<line x1="92" y1="218" x2="1150" y2="218" stroke="${color.line}" stroke-width="2"/>
${text}
<line x1="92" y1="1465" x2="1150" y2="1465" stroke="${color.line}" stroke-width="1.5"/>
<text x="92" y="1525" font-family="PingFang SC, Noto Sans SC, sans-serif" font-size="24" fill="${color.muted}">有据 · 内容工作台</text>
</svg>`;
}
