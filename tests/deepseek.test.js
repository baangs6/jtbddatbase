const test = require('node:test');
const assert = require('node:assert/strict');
const research = require('../services/deepseekHiring');
const company = { name: 'Example Company', verifiedWebsite: 'https://example.com' };
const response = data => ({ ok: true, json: async () => data });
test('DeepSeek research uses company-only prompt, key header and server search', async () => {
  const result = await research({ company, apiKey: 'test-only-key', fetcher: async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(opts.headers['x-api-key'], 'test-only-key');
    const request = JSON.parse(opts.body);
    assert.equal(request.tools[0].name, 'web_search');
    assert.ok(request.messages[0].content.includes('Company to research: Example Company'));
    assert.ok(!opts.body.includes('test-only-key'));
    return response({ stop_reason: 'end_turn', content: [{ type: 'web_search_tool_result', content: [{ title: 'Careers', url: 'https://example.com/jobs' }] }, { type: 'text', text: '| Company | Hiring Status |\n| Example Company | UNVERIFIED |' }] });
  } });
  assert.equal(result.evidenceAvailable, true);
  assert.equal(result.sources.length, 1);
  assert.ok(!JSON.stringify(result).includes('test-only-key'));
});
test('Unsupported search, unsafe sources and truncated replies never produce hiring claims', async () => {
  for (const content of [[], [{ type: 'web_search_tool_result', content: [{ url: 'javascript:alert(1)' }] }]]) {
    const r = await research({ company, apiKey: 'test-only', fetcher: async () => response({ stop_reason: 'end_turn', content: [...content, { type: 'text', text: 'YES - Actively Hiring' }] }) });
    assert.equal(r.evidenceAvailable, false);
    assert.ok(r.answer.startsWith('UNVERIFIED'));
  }
  const r = await research({ company, apiKey: 'test-only', fetcher: async () => response({ stop_reason: 'max_tokens', content: [{ type: 'web_search_tool_result', content: [{ url: 'https://example.com/jobs' }] }, { type: 'text', text: 'YES' }] }) });
  assert.equal(r.evidenceAvailable, false);
});
test('Provider errors do not echo keys', async () => {
  await assert.rejects(research({ company, apiKey: 'test-only-secret', fetcher: async () => ({ ok: false, status: 401 }) }), /rejected the API key/);
});
