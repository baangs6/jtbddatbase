const test = require('node:test');
const assert = require('node:assert/strict');
const transact = require('../services/transferTransaction');

test('restarts an unlabelled aborted transaction in a fresh transaction', async () => {
  let attempts = 0;
  const sessions = [];
  const connection = { transaction: async work => {
    const session = { attempt: ++attempts }; sessions.push(session);
    if (attempts < 3) throw Object.assign(new Error('Transaction with { txnNumber: 3 } has been aborted.'), { code: 251 });
    return work(session);
  } };
  assert.equal(await transact(connection, session => session.attempt, { delay: async () => {} }), 3);
  assert.equal(new Set(sessions).size, 3);
});

test('stops after three conflicts and does not retry validation or duplicate errors', async () => {
  for (const [code, expected] of [[251, 3], [11000, 1], [400, 1]]) {
    let attempts = 0;
    const error = Object.assign(new Error('Failed'), { code });
    await assert.rejects(transact({ transaction: async () => { attempts++; throw error; } }, () => {}, { delay: async () => {} }), e => e === error);
    assert.equal(attempts, expected);
  }
});
