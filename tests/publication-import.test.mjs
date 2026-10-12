import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicationCsv, previewPublicationImport, publicationImportFingerprint, publicationImportTemplate } from '../lib/publication-import.mjs';

const headers = 'taskId,draftId,platform,url,trafficType,publishedAt,observedAt,dataSource,metricDefinition,impressions,clicks,spend,revenue,note';
const line = 't1,d1,小红书,https://example.com/note,paid,2026-09-01,2026-09-02,人工核对后台导出,点击次数口径,100,20,10,50,实际记录';
const csv = `${headers}\r\n${line}`;

test('CSV handles UTF8 BOM, quoted commas, multiline and escaped double quotes', () => {
  assert.deepEqual(parsePublicationCsv('\uFEFFa,b\r\n"含,逗号","第一行\n""第二行"""\r\n'), [['a','b'], ['含,逗号','第一行\n"第二行"']]);
  assert.throws(() => parsePublicationCsv('a\n"unfinished'), /未闭合/);
  assert.throws(() => parsePublicationCsv('a\n"x"y'), /引号格式/);
});
test('preview normalizes required provenance and metrics without fabricated defaults', () => {
  const result = previewPublicationImport(csv);
  assert.equal(result.valid, true); assert.equal(result.rows[0].status, 'ready');
  assert.equal(result.rows[0].publication.metrics.clicks, 20);
  assert.equal(result.rows[0].publication.dataSource, '人工核对后台导出');
  const empty = previewPublicationImport(csv.replace(',100,20,10,50,', ',,0,,,')).rows[0].publication.metrics;
  assert.equal(empty.impressions, null); assert.equal(empty.clicks, 0); assert.equal(empty.spend, null);
});
test('strict headers reject unknown, aliases duplicated, wrong lengths and empty datasets', () => {
  assert.equal(previewPublicationImport(csv.replace('clicks', 'mystery')).ok, false);
  assert.equal(previewPublicationImport(csv.replace('clicks', '曝光')).ok, false);
  assert.equal(previewPublicationImport(`${csv},extra`).ok, false);
  assert.equal(previewPublicationImport(publicationImportTemplate()).ok, false);
  assert.ok(publicationImportTemplate({language:'en'}).startsWith('\uFEFFtaskId,draftId'));
});
test('invalid numbers, dates, blank provenance and traffic types are rejected', () => {
  for (const [from, to] of [[',100,20,', ',-1,20,'],[',100,20,', ',Infinity,20,'],['2026-09-02','2026-02-30'],['2026-09-02','2026-08-01'],['人工核对后台导出',''],[',paid,',',invalid,'],['https://example.com/note','javascript:alert(1)']]) {
    const result = previewPublicationImport(csv.replace(from, to));
    assert.equal(result.ok, false, `${from} => ${to}`);
    assert.ok(result.errors.every(error => 'row' in error && typeof error.message === 'string'));
  }
});
test('duplicate rows are safely skipped; conflicting observations reject entire batch', () => {
  const repeated = previewPublicationImport(`${csv}\n${line}`);
  assert.equal(repeated.ok, true); assert.equal(repeated.summary.duplicate, 1); assert.equal(repeated.summary.ready, 1);
  const conflict = previewPublicationImport(`${csv}\n${line.replace(',100,20,',',101,20,')}`);
  assert.equal(conflict.ok, false); assert.match(conflict.errors[0].message, /不同数据/);
  const known = previewPublicationImport(csv).rows[0];
  assert.equal(previewPublicationImport(csv, {existingRows:[known]}).summary.duplicate, 1);
  assert.equal(previewPublicationImport(csv, {existingRows:[{id:known.taskId,publication:known.publication}]}).summary.duplicate, 1);
});
test('stable fingerprint ignores object ordering, missing metrics and resolved version', () => {
  const publication = previewPublicationImport(csv).rows[0].publication;
  const equivalent = {...publication,version:3,metrics:{...publication.metrics,likes:null}};
  assert.equal(publicationImportFingerprint('t1',publication),publicationImportFingerprint('t1',equivalent));
});
test('new observation may append to existing history but only one new snapshot per task per batch', () => {
  const existing = previewPublicationImport(csv).rows[0];
  const next = csv.replace('2026-09-02','2026-09-03');
  assert.equal(previewPublicationImport(next,{existingRows:[existing]}).ok,true);
  assert.equal(previewPublicationImport(`${csv}\n${line.replace('2026-09-02','2026-09-03')}`).ok,false);
});

test('Chinese headers and traffic labels map explicitly; CSV stays bounded', () => {
  const chinese = csv.replace('taskId','任务ID').replace('draftId','稿件ID').replace('dataSource','数据来源').replace(',paid,',',效果投放,');
  assert.equal(previewPublicationImport(chinese).rows[0].publication.trafficType,'paid');
  assert.throws(() => parsePublicationCsv('a\n' + 'x\n'.repeat(501)), /500/);
  assert.throws(() => parsePublicationCsv('a'.repeat(2_000_001)), /2 MB/);
});
