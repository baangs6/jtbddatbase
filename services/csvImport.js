const csv = require('csv-parser');
const { Readable } = require('stream');
module.exports = buffer => new Promise((resolve, reject) => {
  const rows = []; let headers = [];
  const parser = csv({ strict: true, maxRowBytes: 64 * 1024, mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim() });
  parser.on('headers', value => { headers = value; if (new Set(headers).size !== headers.length) parser.destroy(new Error('CSV contains duplicate column headings.')); });
  parser.on('data', row => { rows.push(row); if (rows.length > 20000) parser.destroy(new Error('Import up to 20,000 contacts per file.')); });
  parser.on('error', e => reject(Object.assign(e, { status: 400 }))); parser.on('end', () => resolve({ rows, headers }));
  Readable.from(buffer).pipe(parser);
});
