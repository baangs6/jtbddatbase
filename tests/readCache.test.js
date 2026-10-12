const test = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../services/readCache');
test('coalesces simultaneous reads and invalidates after writes', async () => {
  let calls = 0;
  const read = cache(async () => ++calls);
  assert.deepEqual(await Promise.all([read(), read(), read()]), [1, 1, 1]);
  assert.equal(await read(), 1);
  read.invalidate();
  assert.equal(await read(), 2);
});
test('a stale pending read cannot replace a newer invalidated snapshot', async () => {
  const finish = [];
  const read = cache(() => new Promise(resolve => finish.push(resolve)));
  const old = read(); await Promise.resolve(); read.invalidate();
  const fresh = read(); await Promise.resolve();
  finish[1]('new'); await fresh;
  finish[0]('old'); await old;
  assert.equal(await read(), 'new');
});
test('failed reads can be retried and expired snapshots are refreshed', async () => {
  let calls = 0;
  const read = cache(async () => { if (++calls === 1) throw new Error('offline'); return calls; }, 0);
  await assert.rejects(read(), /offline/);
  assert.equal(await read(), 2);
  assert.equal(await read(), 3);
});
