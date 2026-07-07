const wsUrl = process.argv[2];
const expr = process.argv.slice(3).join(" ");
let seq = 0;
const ws = new WebSocket(wsUrl);
const pending = new Map();
function call(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout " + method));
      }
    }, 15000);
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error
      ? p.reject(new Error(JSON.stringify(msg.error)))
      : p.resolve(msg.result);
  }
};
ws.onopen = async () => {
  try {
    await call("Runtime.enable");
    const res = await call("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    console.log(JSON.stringify(res.result.value ?? res.result, null, 2));
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
};
