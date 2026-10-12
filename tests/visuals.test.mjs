import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { visualAssets, visualSvg, wrapVisualText, measureVisualText, VISUAL_CONTENT_BOTTOM } from '../public/visuals.js';

function sourceCopy(assets, sourcePage, role) {
  return assets.filter(asset => asset.sourcePage === sourcePage).flatMap(asset => asset.lines).filter(line => line.role === role).map(line => line.raw).join('');
}
function assertWithinBounds(assets) {
  for (const asset of assets) {
    for (let i = 0; i < asset.lines.length; i++) {
      const line = asset.lines[i];
      assert.ok(line.bottom <= VISUAL_CONTENT_BOTTOM, `text must stay above footer: ${line.bottom}`);
      assert.ok(line.x + line.renderWidth <= 1150);
      if (i) assert.ok(asset.lines[i - 1].bottom < line.y - line.size * 0.7, 'consecutive text blocks must not overlap');
    }
  }
}

test('long Chinese headings and body paginate without losing source copy or reaching footer', () => {
  const heading = '这是很长的中文标题，需要完整保留而不能截字。'.repeat(21);
  const body = '这是一段中文说明，包含关键内容与适用边界。'.repeat(170) + '\n\n末尾信息不能消失。';
  const draft = { title: '隔离排版测试', cover: '封面测试', pages: [{ heading, text: body }], tags: ['排版测试'] };
  const assets = visualAssets(draft);
  assert.equal(sourceCopy(assets, 1, 'heading'), heading);
  assert.equal(sourceCopy(assets, 1, 'body'), body);
  assert.ok(assets.length > 6);
  assertWithinBounds(assets);
});

test('overflowing cover and subtitle both survive across distinct cover parts', () => {
  const cover = '不能截掉封面标题'.repeat(80);
  const title = '副标题也需要完整保留'.repeat(90);
  const assets = visualAssets({ title, cover, pages: [], tags: [] });
  assert.equal(sourceCopy(assets, 0, 'heading'), cover);
  assert.equal(sourceCopy(assets, 0, 'body'), title);
  assert.ok(assets.length > 2);
  assert.deepEqual(assets.map(asset => asset.part), assets.map((_, index) => index + 1));
  assert.ok(assets.every(asset => asset.parts === assets.length));
  assertWithinBounds(assets);
});

test('English words, long URLs, and exact whitespace are preserved with proportional widths', () => {
  const source = '  A proportionally spaced English heading\r\n\n' + 'https://example.test/' + 'LongUnbrokenSegment'.repeat(80) + '\t trailing spaces  ';
  const wrapped = wrapVisualText(source, 700, 42);
  assert.equal(wrapped.map(line => line.raw).join(''), source);
  assert.ok(wrapped.every(line => line.width <= 700));
  assert.ok(measureVisualText('iiiiiiii') < measureVisualText('WWWWWWWW'));
  assert.throws(() => wrapVisualText('text', 0), /正数/);
});

test('emoji families, flags, variation selectors, and combining accents stay in whole graphemes', () => {
  const emoji = ['👨‍👩‍👧‍👦', '👍🏽', '🇨🇳', '1️⃣', 'e\u0301', '✈️'];
  const source = emoji.join('').repeat(60);
  const lines = wrapVisualText(source, 120, 42);
  assert.equal(lines.map(line => line.raw).join(''), source);
  const boundaries = new Set([0]); let position = 0;
  for (const item of new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(source)) { position += item.segment.length; boundaries.add(position); }
  position = 0;
  for (const line of lines) { position += line.raw.length; assert.ok(boundaries.has(position)); }
});

test('fifteen-line body and three-line heading have separate space and spill to the next card', () => {
  const draft = { title: '排版测试', cover: '', pages: [{ heading: '第一行标题\n第二行标题\n第三行标题', text: Array.from({ length: 15 }, (_, index) => `第${index + 1}行正文`).join('\n') }], tags: [] };
  const assets = visualAssets(draft);
  assert.ok(assets.filter(asset => asset.sourcePage === 1).length > 1);
  assert.equal(sourceCopy(assets, 1, 'body'), draft.pages[0].text);
  assertWithinBounds(assets);
});

test('plain imported copy and all tags become template assets when no page outline exists', () => {
  const body = '外部稿件正文。'.repeat(120);
  const tags = Array.from({ length: 30 }, (_, index) => `长标签内容${index}`);
  const assets = visualAssets({ title: '测试标题', body, pages: [], tags });
  assert.equal(sourceCopy(assets, 1, 'body'), body);
  assert.equal(sourceCopy(assets, 1, 'tags'), tags.map(tag => `#${tag}`).join('  '));
  assertWithinBounds(assets);
});

test('SVG escapes copy, renders every laid-out line, and clearly describes deterministic template output', () => {
  const draft = { title: '<script>alert("test")</script>', cover: '引用 & <标签> "双引号"', pages: [{ heading: '模板', text: '第一行\n第二行👨‍👩‍👧‍👦' }], tags: [] };
  const assets = visualAssets(draft);
  assets.forEach((asset, index) => {
    const svg = visualSvg(draft, asset, index, assets.length);
    const { document } = parseHTML(svg);
    assert.equal(document.querySelectorAll('script').length, 0);
    assert.equal(document.querySelectorAll('text[data-role]').length, asset.lines.length);
    assert.match(svg, /非AI生成图片/);
    assert.ok([...document.querySelectorAll('text')].every(node => !node.textContent.includes('模板排版 · 发布前人工核验')));
    assert.ok(!svg.includes('<foreignObject'));
    assertWithinBounds([asset]);
  });
  assert.throws(() => visualSvg(draft, { kind: 'cover', heading: 'legacy' }), /完整分页/);
});

test('empty copy is not replaced with invented product content', () => {
  const assets = visualAssets({ title: '', body: '', pages: [], tags: [] });
  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0].lines, []);
});

test('visual preview and SVG redact contacts before layout without modifying source copy', () => {
  const draft = { title: '联系 test@example.com', body: '手机 13812345678', pages: [], tags: ['test@example.com'] };
  const original = JSON.stringify(draft);
  const assets = visualAssets(draft);
  const svg = assets.map((asset, index) => visualSvg(draft, asset, index, assets.length)).join('\n');
  assert.doesNotMatch(JSON.stringify(assets) + svg, /test@example\.com|13812345678/);
  assert.match(svg, /邮箱已隐藏|手机已隐藏/);
  assert.equal(JSON.stringify(draft), original);
});

test('credentials block visual exports and cannot enter through a supplied SVG asset', () => {
  const draft = { title: '安全标题', body: '安全正文', pages: [], tags: [] };
  assert.throws(() => visualAssets({ ...draft, body: 'Bearer abcdefgh123456' }), /凭据/);
  const asset = visualAssets(draft)[0];
  assert.throws(() => visualSvg({ ...draft, title: 'sk-abcdefgh123456' }, asset), /凭据/);
  assert.throws(() => visualSvg(draft, { ...asset, lines: [{ ...asset.lines[0], text: 'sk-abcdefgh123456' }] }), /凭据/);
});
