// Minimal DevTools-protocol driver for the dev instance: headless Chrome signed in with a curl
// cookie jar from scripts/dev-setup.sh. Not part of the test suite; it proves the page end to end.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const PORT = Number(process.env.CDP_PORT || 9344);
export const ORIGIN = process.env.ORIGIN || 'http://localhost:3300';

function jarCookies(path) {
  return readFileSync(path, 'utf8').split('\n')
    .filter((l) => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_')))
    .map((l) => {
      const f = l.split('\t');
      return { name: f[5], value: f[6], url: ORIGIN, httpOnly: l.startsWith('#HttpOnly_') };
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withBrowser(jarPath, fn) {
  const profile = mkdtempSync(join(tmpdir(), 'batteries-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=420,1600', 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 100 && !target; i += 1) {
      try { target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(100); }
    }
    if (!target) throw new Error('chrome did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const errors = [];
    const requests = [];
    const dialogs = [];
    const send = (method, params = {}) => new Promise((res, rej) => {
      id += 1;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
      if (msg.method === 'Runtime.exceptionThrown') errors.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
      if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.includes('/api/extensions/batteries')) {
        requests.push(`${msg.params.request.method} ${new URL(msg.params.request.url).pathname}`);
      }
      if (msg.method === 'Page.javascriptDialogOpening') { dialogs.push(msg.params.message); send('Page.handleJavaScriptDialog', { accept: true }); }
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
    await send('Network.setCookies', { cookies: jarCookies(jarPath) });
    // The browser picks its locale from localStorage/navigator.languages, not from the server
    // preference; headless Chrome reports en-US, so pin the household's locale like a real
    // Spanish browser would.
    await send('Page.navigate', { url: ORIGIN + '/health' });
    await sleep(200);
    await send('Runtime.evaluate', { expression: "localStorage.setItem('yuvomi-locale', 'es')" });

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const page = {
      errors, requests, dialogs, evaluate,
      async goto(path) { await send('Page.navigate', { url: ORIGIN + path }); await sleep(300); },
      async waitFor(expression, timeout = 10_000) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          try { if (await evaluate(expression)) return true; } catch { /* page still loading */ }
          await sleep(150);
        }
        throw new Error(`timeout waiting for ${expression}`);
      },
      async click(selector) {
        await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
      },
      async fill(formSelector, values) {
        await evaluate(`(() => {
          const f = document.querySelector(${JSON.stringify(formSelector)});
          if (!f) throw new Error('no form ' + ${JSON.stringify(formSelector)});
          for (const [k, v] of Object.entries(${JSON.stringify(values)})) {
            const el = f.elements[k];
            if (!el) throw new Error('no field ' + k);
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return true;
        })()`);
      },
      async submit(formSelector) {
        await evaluate(`(() => { document.querySelector(${JSON.stringify(formSelector)}).requestSubmit(); return true; })()`);
      },
      text: (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`),
      async screenshot(path) {
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(path, Buffer.from(data, 'base64'));
      },
    };
    return await fn(page);
  } finally {
    chrome.kill('SIGKILL');
  }
}
