/** Local synthetic production-build evidence; follows screenshots.ts / pane-benchmark.ts.
 * Run `make build`, then `scripts/bun run scripts/cache-feedback-evidence.ts [output-dir]`.
 * Chrome required (CHROME_BIN overrides its path). Uses ephemeral loopback ports,
 * a temporary browser profile and an isolated synthetic ledger; never the user's server.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? join(root, "output/cache-feedback"));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "yald-cache-evidence-"));
async function freePort() {
  return new Promise<number>((done, reject) => {
    const probe = createServer(); probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => { const address = probe.address() as { port: number }; probe.close(() => done(address.port)); });
  });
}
const port = await freePort(), debugPort = await freePort();
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const server = spawn(join(root, "scripts/bun"), ["run", "scripts/preview-fixture.ts", "--scope"], { cwd: root, env: { ...process.env, YALD_PREVIEW_PORT: String(port) }, stdio: "ignore" });
const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${scratch}`, "about:blank"], { stdio: "ignore" });
let socket: WebSocket | undefined;
let sequence = 0;
const pending = new Map<number, (value: any) => void>();
async function cdp(method: string, params = {}) {
  const id = ++sequence;
  return new Promise<any>((done, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, response => { clearTimeout(timer); pending.delete(id); response.error ? reject(Error(JSON.stringify(response.error))) : done(response.result); });
    socket!.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression: string) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression: string, attempts = 100) {
  for (let i = 0; i < attempts; i++) { if (await evaluate(expression)) return; await Bun.sleep(100); }
  throw Error(`Condition failed: ${expression}; state=${JSON.stringify(await evaluate("({url:location.href,fetches:window.__cacheFetches,before:window.__before,main:document.querySelector('main')?.innerText})"))}`);
}
async function capture(name: string) {
  await Bun.sleep(400);
  const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(output, `${name}.png`), Buffer.from(data, "base64"));
}
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok && (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch {}
    if (i === 99) throw Error("Synthetic server/Chrome did not start");
    await Bun.sleep(100);
  }
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" }).then(r => r.json()) as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((done, reject) => { socket!.onopen = () => done(); socket!.onerror = () => reject(Error("Chrome connection failed")); });
  socket.onmessage = event => { const response = JSON.parse(String(event.data)); pending.get(response.id)?.(response); };
  await cdp("Page.enable"); await cdp("Page.bringToFront");
  // Only the cache response fields are replaced; every other API is the isolated synthetic fixture.
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    const originalFetch = window.fetch;
    window.__cacheScenario = 'narrow'; window.__cacheFetches = 0;
    window.fetch = async (...args) => {
      if (!String(args[0]).includes('/api/usage?')) return originalFetch(...args);
      // These bodies are synthetic replacements. A saved response's ETag belongs
      // to the fixture body, not this replacement; 304 has no JSON to replace.
      const headers = new Headers(args[1]?.headers);
      headers.delete('If-None-Match');
      const response = await originalFetch(args[0], {...args[1], headers});
      if (!response.ok) throw Error('Synthetic usage request failed: '+response.status);
      const body = await response.json();
      const rates = window.__cacheScenario === 'empty' ? [null,null] : window.__cacheScenario === 'zero' ? [0,0] : window.__cacheScenario === 'full' ? [1,1] : window.__cacheScenario === 'constant' ? [0.975,0.975] : window.__cacheScenario === 'zero-input' ? [null,null] : window.__cacheScenario === 'single' ? [0.975] : [0.971,0.975,null,0.98,0.973];
      body.cache = rates.map((rate,i) => ({ts:1793491200000+i*86400000,label:'2026-11-0'+(i+1),hitRate:rate,cacheRead:rate===null?0:Math.round(rate*100000000),input:rate===null?0:100000000,eligibleRequests:rate===null&&window.__cacheScenario!=='zero-input'?0:10,totalRequests:12,savingsUsd:0}));
      body.summary.measurementCoverage.cache={eligibleRequests:(window.__cacheScenario==='zero-input'?rates.length:rates.filter(x=>x!==null).length)*10,totalRequests:rates.length*12};
      window.__cacheFetches++;
      return new Response(JSON.stringify(body), {status:200,headers:{'Content-Type':'application/json'}});
    };` });
  const checks: string[] = [];
  for (const width of [1440, 390]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 1200, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/usage?range=all` });
    await until("document.querySelectorAll('canvas').length>=2 && document.body.innerText.includes('96.965%')");
    await capture(`usage-${width}-both`);
    await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='New');b.focus();})()`);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    await until("document.activeElement.textContent==='New' && document.activeElement.getAttribute('aria-pressed')==='true'");
    await capture(`usage-${width}-new`);
    const overflow = await evaluate("document.documentElement.scrollWidth > innerWidth");
    if (overflow) throw Error(`Page overflow at ${width}`);
    for (const scenario of ["zero", "full", "single", "constant", "zero-input", "empty", "narrow"]) {
      await evaluate(`window.__cacheScenario='${scenario}';window.__before=window.__cacheFetches;[...document.querySelectorAll('button')].find(x=>x.title?.includes('Re-read')).click()`);
      await until("window.__cacheFetches>window.__before");
      await until(scenario === "empty" ? "document.body.innerText.includes('No measured cache data')" : "[...document.querySelectorAll('button')].some(x=>x.textContent==='New'&&x.getAttribute('aria-pressed')==='true')");
      const expected = scenario === "zero" ? "0%–0.1%" : scenario === "full" ? "99.9%–100%" : scenario === "single" || scenario === "constant" ? "97.4%–97.6%" : scenario === "zero-input" ? "No input denominator" : scenario === "empty" ? "No measured cache data" : "96.965%–98.135%";
      await until(`document.body.innerText.includes(${JSON.stringify(expected)})`);
      if (scenario === "zero-input") await until("document.querySelector('details tbody')?.textContent.includes('Unavailable00')");
      if (scenario !== "narrow") await capture(`usage-${width}-${scenario}`);
    }

    await evaluate("document.querySelector('details').open=true");
    await capture(`usage-${width}-exact`);
    // Use an uncached preset at each width: the second page load can hydrate
    // the desktop's 90d response from IndexedDB without an immediate request.
    const preset = width === 1440 ? "90d" : "7d";
    await evaluate(`window.__cacheScenario='single';window.__before=window.__cacheFetches;[...document.querySelectorAll('button')].find(x=>x.textContent==='${preset}').click()`);
    await until("window.__cacheFetches>window.__before && [...document.querySelectorAll('button')].some(x=>x.textContent==='New'&&x.getAttribute('aria-pressed')==='true')");
    await until("document.body.innerText.includes('97.4%–97.6%')");
    await evaluate("window.__cacheScenario='narrow';window.__before=window.__cacheFetches");
    // Exercise the actual 30-second background refetch, with no button click.
    await until("window.__cacheFetches>window.__before && document.body.innerText.includes('96.965%–98.135%') && [...document.querySelectorAll('button')].some(x=>x.textContent==='New'&&x.getAttribute('aria-pressed')==='true')", 400);
    // Explicitly reject the old desktop grid rule that placed every card in row one.
    if (await evaluate("(()=>{const cards=[...document.querySelectorAll('.editorial-usage > .widget-card')].map(x=>x.getBoundingClientRect());return cards.length===2 && cards[0].bottom>cards[1].top;})()")) throw Error('Cache and activity cards overlap');
    checks.push(`${width}px: keyboard Enter isolates New; manual/background refresh and filter preserve selection and recalculate bounds; cards do not overlap; zero/full/single/constant/zero-input/empty states; no page overflow`);
    for (const [route, name, absent] of [["/", "overview", ["Success rate", "Median TTFT"]], ["/performance", "performance", ["Outage episodes", "1 upstream"]]] as const) {
      await cdp("Page.navigate", { url: `http://127.0.0.1:${port}${route}?range=all` });
      await until("document.querySelector('main h1')!==null && document.querySelector('main').innerText.length>100");
      await Bun.sleep(500);
      const text = await evaluate("document.querySelector('main').innerText");
      if (absent.some(label => text.includes(label))) throw Error(`Removed UI present: ${name}`);
      await capture(`${name}-${width}`);
    }
  }
  await writeFile(join(output, "checks.json"), JSON.stringify({ evidence: "synthetic production build + overridden cache response; not installed-user runtime evidence", checks }, null, 2));
  console.log(JSON.stringify({ output, checks }));
} finally {
  socket?.close(); browser.kill("SIGTERM"); server.kill("SIGTERM");
  await new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once("exit", () => done()); setTimeout(done, 5000); } });
  await rm(scratch, { recursive: true, force: true });
}
