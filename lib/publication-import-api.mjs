import { createHash, randomBytes } from 'node:crypto';
import { previewPublicationImport, publicationImportTemplate } from './publication-import.mjs';

// Preview never writes. The token binds confirmation to both CSV bytes and the
// current workspace revision; all validation is repeated before atomic commit.
export function createPublicationImportHandler(store) {
  const secret = randomBytes(32).toString('hex');
  const tokenFor = csv => createHash('sha256').update(secret).update(String(store.getRevision())).update(csv).digest('hex');
  const preview = csv => {
    if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 800_000) throw new Error('CSV 必须是 UTF-8 文本且不超过 800KB。');
    const tasks = store.listTasks();
    // Chronological history first, current effective value last. A correction
    // must win over the erroneous historical value for the same observation.
    const existingRows = tasks.flatMap(task => [...(task.publicationHistory || []), task.publication].filter(Boolean).map(publication => ({ taskId: task.id, publication })));
    const result = previewPublicationImport(csv, { existingRows });
    const errors = [...(result.errors || [])];
    for (const row of result.rows || []) {
      if (row.status === 'duplicate' || row.errors?.length) continue;
      try {
        store.validatePublications([{ taskId: row.taskId, publication: row.publication }]);
        const previous = tasks.find(task => task.id === row.taskId)?.publication;
        if (previous && previous.url !== row.publication.url) throw new Error('本任务已有另一条发布链接；请为另一篇发布内容建立独立任务，避免覆盖。');
        if (previous?.observedAt && row.publication.observedAt < previous.observedAt) throw new Error('观察日期早于当前发布记录；请核对时间顺序，不覆盖较新的快照。');
      } catch (error) { errors.push({ row: row.rowNumber, message: error.message }); }
    }
    return { ...result, errors, valid: Boolean(result.valid) && errors.length === 0, token: tokenFor(csv) };
  };
  return {
    template: () => publicationImportTemplate({ language: 'zh' }),
    preview,
    commit({ csv, token } = {}) {
      if (typeof csv !== 'string' || typeof token !== 'string' || token !== tokenFor(csv)) {
        const error = new Error('导入内容或工作区已变化，请重新预览后确认。'); error.status = 409; throw error;
      }
      const result = preview(csv);
      if (!result.valid) throw new Error(`CSV 未通过校验：${result.errors.map(error => `第 ${error.row || '?'} 行 ${error.message}`).join('；')}`);
      const rows = result.rows.filter(row => row.status !== 'duplicate');
      store.importPublications(rows.map(({ taskId, publication }) => ({ taskId, publication })));
      return { imported: rows.length, skipped: result.rows.length - rows.length };
    },
  };
}
