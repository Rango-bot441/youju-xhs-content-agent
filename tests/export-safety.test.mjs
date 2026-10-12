import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectExportSafety, sanitizeExport, safeExportFileName } from '../public/export-safety.js';

test('one recursive export policy protects all nested fields and filenames without mutating records', () => {
  const original = { title: 'test@example.com', pages: [{ text: '13812345678' }], review: { details: ['test@example.com'] } };
  const safe = sanitizeExport(original);
  assert.doesNotMatch(JSON.stringify(safe), /test@example\.com|13812345678/);
  assert.equal(original.pages[0].text, '13812345678');
  assert.equal(safeExportFileName(original.title), '[邮箱已隐藏]');
  assert.equal(inspectExportSafety(original).hasContactDetails, true);
});

test('credential formats and structured keys block rather than silently escape into exports', () => {
  for (const value of ['Bearer abcdefgh123456', 'sk-abcdefgh123456', 'api_key="abcdefgh123456"', '"access_token":"abcdefgh123456"', { nested: { apiKey: 'abcdefgh123456' } }, '-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----']) {
    assert.equal(inspectExportSafety(value).hasCredentials, true);
    assert.throws(() => sanitizeExport(value), error => error.code === 'EXPORT_CREDENTIAL_BLOCKED' && !error.message.includes('abcdefgh'));
  }
  assert.throws(() => safeExportFileName('sk-abcdefgh123456'), /凭据/);
  assert.equal(inspectExportSafety('API key 配置方法；凭据已隐藏；Bearer [凭据已隐藏]').blocked, false);
});
