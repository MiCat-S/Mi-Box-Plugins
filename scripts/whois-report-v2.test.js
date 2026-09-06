const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {buildPlugin} = require('../../TeleBox-Core/scripts/build-v2-plugin.cjs');
const {artifactDir} = buildPlugin({id: 'whois-report', packageRoot: path.resolve(__dirname, '../whois'), entry: 'v2/report.ts'});
const {report} = require(path.join(artifactDir, 'index.cjs'));

test('whois report extracts anchored fields and calculates expiry relative to supplied time', () => {
  const raw = 'Sponsoring Registrar: wrong\nRegistrar: A<&\nCreation Date: 2020-01-01\nUpdated Date: 2026-01-01\nRegistry Expiry Date: 2026-09-20T00:00:00Z\nName Server: ns1.example.com\nName Server: ns2.example.com\nDomain Status: ok';
  const pages = report('example.com', raw, Date.parse('2026-09-06T00:00:00Z'));
  assert.match(pages[0], /注册商: A&lt;&amp;/);
  assert.match(pages[0], /14 天后过期/);
  assert.match(pages[0], /ns1\.example\.com\nns2\.example\.com/);
  assert.match(pages[0], /注册日期: 2020-01-01/);
});
test('whois preserves all raw characters in independently valid rich-text pages', () => {
  const raw = '<&😀'.repeat(4000);
  const pages = report('example.com', raw);
  assert.ok(pages.every(page => page.length < 3500));
  const restored = pages.slice(1).map(page => page.replace(/^<blockquote expandable>|<\/blockquote>$/g, '')).join('');
  assert.equal(restored, '&lt;&amp;😀'.repeat(4000));
});
test('whois expiry handles invalid dates and alternate expiry field', () => {
  assert.doesNotMatch(report('example.com', 'Registry Expiry Date: invalid')[0], /到期提醒/);
  assert.match(report('example.com', 'Registrar Registration Expiration Date: 2020-01-01', Date.parse('2026-09-06'))[0], /已过期/);
});
