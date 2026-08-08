/**
 * Run async tasks strictly one at a time. Failures do not break the queue.
 */
export function createSerialAsyncQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const current = tail.then(() => task());
    tail = current.catch(() => undefined);
    return current;
  };
}
