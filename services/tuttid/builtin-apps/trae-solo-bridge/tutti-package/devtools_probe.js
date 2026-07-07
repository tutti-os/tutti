const http = require("http");
const wsUrl = process.argv[2];
if (!wsUrl) throw new Error("ws url required");
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
    }, 10000);
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
};
ws.onopen = async () => {
  try {
    await call("Runtime.enable");
    const expr = `(() => {
      const all=[...document.querySelectorAll('textarea,input,[contenteditable="true"],button,[role="button"],div,span')];
      return all.slice(0,500).map((e,i)=>({i, tag:e.tagName, role:e.getAttribute('role'), aria:e.getAttribute('aria-label'), ph:e.getAttribute('placeholder'), text:(e.innerText||e.value||'').slice(0,120), cls:e.className, id:e.id, editable:e.getAttribute('contenteditable'), rect:(()=>{const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}})()})).filter(x=>x.text||x.aria||x.ph||x.editable||x.tag==='TEXTAREA'||x.tag==='INPUT'||x.role==='textbox'||x.role==='button');
    })()`;
    const res = await call("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    console.log(JSON.stringify(res.result.value, null, 2));
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
};
