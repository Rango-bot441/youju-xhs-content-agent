// Ratios are fractions (CTR 0.1 means 10%); CPL is currency/lead and ROAS is a multiple.
export const BUSINESS_METRIC_DEFINITIONS = Object.freeze({
  ctr: { label: 'CTR', numerator: 'clicks', denominator: 'impressions', formula: '点击 / 曝光' },
  cvr: { label: 'CVR', numerator: 'conversions', denominator: 'clicks', formula: '转化 / 点击' },
  cpl: { label: 'CPL', numerator: 'spend', denominator: 'qualifiedLeads', formula: '花费 / 有效咨询' },
  roas: { label: 'ROAS', numerator: 'revenue', denominator: 'spend', formula: '归因收入 / 花费（不是利润 ROI）' },
});

const publicationOf = value => value?.publication || value;
const scopeFields = ['platform', 'trafficType', 'publishedAt', 'observedAt', 'dataSource', 'metricDefinition'];
const present = value => typeof value === 'string' && value.trim().length > 0;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function publicationMetricScope(record) {
  const publication = publicationOf(record);
  if (!publication || !scopeFields.every(field => present(publication[field]))) return null;
  return JSON.stringify(scopeFields.map(field => publication[field].trim()));
}

// Never average ratios, silently drop incomplete records, or pool organic and paid traffic.
export function calculateBusinessMetrics(records = []) {
  const result = { ctr: null, cvr: null, cpl: null, roas: null, recordCount: records.length, reason: '', missing: [] };
  if (!records.length) return { ...result, reason: '尚无发布记录' };
  const publications = records.map(publicationOf);
  const scopes = records.map(publicationMetricScope);
  if (scopes.some(scope => !scope)) return { ...result, reason: '缺少平台、流量类型、发布/观察日期、数据来源或指标口径' };
  if (new Set(scopes).size !== 1) return { ...result, reason: '平台、流量类型、观察窗口、来源或指标口径不同，请分组查看' };
  const urls = publications.map(publication => publication.url).filter(present);
  if (new Set(urls).size !== urls.length) return { ...result, reason: '存在重复发布链接，请先去重，避免重复计算' };
  for (const [name, definition] of Object.entries(BUSINESS_METRIC_DEFINITIONS)) {
    const { numerator, denominator } = definition;
    if (publications.some(publication => !numeric(publication.metrics?.[numerator]) || !numeric(publication.metrics?.[denominator]))) {
      result.missing.push(name); continue;
    }
    const top = publications.reduce((sum, publication) => sum + publication.metrics[numerator], 0);
    const bottom = publications.reduce((sum, publication) => sum + publication.metrics[denominator], 0);
    if (bottom > 0 && Number.isFinite(top) && Number.isFinite(bottom) && Number.isFinite(top / bottom)) result[name] = top / bottom;
    else result.missing.push(name);
  }
  if (result.missing.length) result.reason = '部分指标缺少分子/分母或分母为 0，不按 0 计算';
  return result;
}

export function groupBusinessMetrics(records = []) {
  const groups = new Map();
  records.forEach((record, index) => {
    const scope = publicationMetricScope(record) || `incomplete:${index}`;
    if (!groups.has(scope)) groups.set(scope, []);
    groups.get(scope).push(record);
  });
  return [...groups.entries()].map(([scope, items]) => ({
    scope, ...Object.fromEntries(scopeFields.map(field => [field, publicationOf(items[0])?.[field] || ''])),
    ...calculateBusinessMetrics(items),
  }));
}
