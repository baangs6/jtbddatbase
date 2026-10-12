// The driver retries labelled transaction conflicts. Atlas can also return an
// unlabelled NoSuchTransaction (251), which needs a fresh transaction/session.
const retryable = error => [112, 244, 251].includes(error.code) ||
  error.hasErrorLabel?.('TransientTransactionError') ||
  /transaction.*(?:has been aborted|has been committed|does not exist)/i.test(error.message || '');

module.exports = async (connection, work, { attempts = 3, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) => {
  for (let attempt = 1; ; attempt++) {
    try { return await connection.transaction(work, { maxCommitTimeMS: 15000 }); }
    catch (error) {
      if (!retryable(error) || attempt >= attempts) throw error;
      await delay(200 * attempt + Math.floor(Math.random() * 200));
    }
  }
};
module.exports.retryable = retryable;
