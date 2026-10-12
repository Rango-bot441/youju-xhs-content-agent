import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBusinessMetrics, groupBusinessMetrics } from '../public/business-metrics.js';
const publication = (patch={}) => ({platform:'小红书',trafficType:'paid',publishedAt:'2026-09-01',observedAt:'2026-09-02',dataSource:'后台导出',metricDefinition:'点击次数/有效咨询人工定义/归因收入同窗口',metrics:{impressions:100,clicks:20,conversions:2,qualifiedLeads:4,spend:10,revenue:50},...patch});

test('business metric definitions are explicit and ROAS is not profit ROI', () => {
  const actual = calculateBusinessMetrics([publication()]);
  assert.equal(actual.ctr,.2); assert.equal(actual.cvr,.1); assert.equal(actual.cpl,2.5); assert.equal(actual.roas,5);
  assert.equal(actual.roi,undefined);
});
test('missing, null and zero denominator are not silently converted to zero', () => {
  for (const value of [undefined,null,'',NaN,-1]) assert.equal(calculateBusinessMetrics([publication({metrics:{impressions:100,clicks:value}})]).ctr,null);
  assert.equal(calculateBusinessMetrics([publication({metrics:{impressions:0,clicks:0}})]).ctr,null);
  assert.equal(calculateBusinessMetrics([publication({metrics:{impressions:100,clicks:0}})]).ctr,0);
  assert.equal(calculateBusinessMetrics([publication(),publication({metrics:{impressions:100}})]).ctr,null);
});
test('different traffic, window or source never pools into an apparently valid metric', () => {
  for(const patch of [{trafficType:'organic'},{observedAt:'2026-09-03'},{publishedAt:'2026-08-01'},{dataSource:'另一数据源'},{metricDefinition:''}]) {
    assert.equal(calculateBusinessMetrics([publication(),publication(patch)]).ctr,null);
  }
  const groups=groupBusinessMetrics([publication(),publication({trafficType:'organic'})]);
  assert.equal(groups.length,2); assert.equal(groups[0].ctr,.2);
});
test('weighted aggregate uses complete same-scope numerator and denominator, not mean of rates', () => {
  const actual=calculateBusinessMetrics([publication(),publication({metrics:{impressions:900,clicks:90}})]);
  assert.equal(actual.ctr,.11);
  assert.equal(calculateBusinessMetrics([{publication:publication()}]).ctr,.2);
  assert.equal(calculateBusinessMetrics([publication({url:'https://a.test/n'}),publication({url:'https://a.test/n'})]).ctr,null);
});
