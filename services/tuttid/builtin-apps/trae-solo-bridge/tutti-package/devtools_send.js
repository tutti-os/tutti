const http = require("http");
const mode = process.argv[2] || "design";
const prompt = process.argv.slice(3).join(" ");
function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}
(async () => {
  const targets = await getJson("http://127.0.0.1:9229/json/list");
  const page =
    targets.find((t) => t.type === "page" && /solo-lite/.test(t.url)) ||
    targets.find((t) => t.type === "page");
  if (!page) throw new Error("no devtools page");
  let seq = 0;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
      }, 20000);
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
  await new Promise((resolve) => (ws.onopen = resolve));
  await call("Runtime.enable");
  const expr = `async () => {
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const mode = ${JSON.stringify(mode)};
    const prompt = ${JSON.stringify(prompt)};
    const norm = s => String(s||'').trim().toLowerCase();
    const visible = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && r.x>=0 && r.y>=0; };
    const clickEl = e => { e.scrollIntoView?.({block:'center', inline:'center'}); e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0})); e.click(); };
    const tabs=[...document.querySelectorAll('button[role="tab"],button,.tab-pLFRtu')];
    const tab=tabs.find(e=>norm(e.innerText)===mode);
    if(!tab) return {ok:false, step:'find-tab', tabs:tabs.map(e=>e.innerText)};
    clickEl(tab); await sleep(700);
    const newButtons=[...document.querySelectorAll('button,[role="button"],.task-list-new-task-item')];
    const newTask=newButtons.find(e=>/新建任务|New task/i.test(e.innerText||e.getAttribute('aria-label')||'') && visible(e));
    if(!newTask) return {ok:false, step:'find-new-task', candidates:newButtons.slice(0,30).map(e=>({t:e.innerText,a:e.getAttribute('aria-label'),c:e.className}))};
    clickEl(newTask); await sleep(1500);
    let editable=[...document.querySelectorAll('[contenteditable="true"],textarea,input[role="textbox"],div[role="textbox"]')].filter(visible).sort((a,b)=>b.getBoundingClientRect().y-a.getBoundingClientRect().y)[0];
    if(!editable) return {ok:false, step:'find-editor'};
    editable.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, prompt);
    editable.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null}));
    editable.dispatchEvent(new Event('change',{bubbles:true}));
    await sleep(800);
    const sendButtons=[...document.querySelectorAll('button,.chat-input-v2-send-button')].filter(visible);
    let send=sendButtons.find(e=>String(e.className).includes('chat-input-v2-send-button')) || sendButtons.reverse().find(e=>e.getBoundingClientRect().x>1000 && e.getBoundingClientRect().y>750);
    if(!send) return {ok:false, step:'find-send', text:editable.innerText, buttons:sendButtons.map(e=>({t:e.innerText,a:e.getAttribute('aria-label'),c:e.className,r:(()=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()}))};
    const before=document.body.innerText;
    clickEl(send); await sleep(1200);
    const after=document.body.innerText;
    return {ok:true, mode, promptLen:prompt.length, editorText:editable.innerText.slice(0,120), sendClass:String(send.className), bodyChanged:before!==after, bodyTail:after.slice(-500)};
  }`;
  const res = await call("Runtime.evaluate", {
    expression: `(${expr})()`,
    awaitPromise: true,
    returnByValue: true
  });
  console.log(JSON.stringify(res.result.value ?? res.result, null, 2));
  ws.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
