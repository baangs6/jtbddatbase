module.exports = (read, ttl = 15000) => {
  let value, expires = 0, pending, generation = 0;
  const get = async () => {
    if (Date.now() < expires) return value;
    if (!pending) {
      const version = generation;
      const request = Promise.resolve().then(read).then(result => {
        if (version === generation) { value = result; expires = Date.now() + ttl; }
        return result;
      }).finally(() => { if (pending === request) pending = undefined; });
      pending = request;
    }
    return pending;
  };
  get.invalidate = () => { generation++; expires = 0; pending = undefined; };
  return get;
};
