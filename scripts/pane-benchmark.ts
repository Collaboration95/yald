import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { materializeFixtureHome } from "../web/scripts/fixtureHome";

// Local, synthetic-data pane switch benchmark. Requires Chrome/Chromium and Bun.
const root = join(import.meta.dir, "..");
const chrome = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(path => Bun.file(path).size > 0);
if (!chrome) throw new Error("Chrome required; set CHROME_BIN to Chrome or Chromium.");
const panes = [
  ["Overview", "/"], ["Usage", "/usage"], ["Cost & spend", "/cost"], ["Performance", "/performance"],
  ["Reliability", "/reliability"], ["Models", "/models"], ["Quota", "/quota"], ["Conversations", "/conversations"],
] as const;
const defaultSizes = [98, 10_000, 66_000];
const requestedSize = Number(process.env.YALD_BENCH_ROWS);
const sizes = Number.isInteger(requestedSize) && defaultSizes.includes(requestedSize) ? [requestedSize] : defaultSizes;
const scratch = await mkdtemp(join(tmpdir(), "yald-pane-benchmark-"));
const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("No free port"));
    server.close(error => error ? reject(error) : resolvePort(address.port));
  });
});
const debugPort = port + 1;
const fixture = await materializeFixtureHome();
const baseUsage = (await readFile(join(fixture, "usage.jsonl"), "utf8")).trim().split("\n");
const chromeProfile = join(scratch, "chrome");
const chromeProcess = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${chromeProfile}`, "about:blank"], { stdio: "ignore" });
const round = (n: number) => Number(n.toFixed(2));
const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!);
};

let socket: WebSocket | undefined;
let sequence = 0;
const pending = new Map<number, (value: any) => void>();
async function cdp(method: string, params: object = {}) {
  const id = ++sequence;
  return await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    socket!.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression: string) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
  return result.result?.result?.value;
}
async function waitUntil(expression: string, timeout = 20_000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    if (await evaluate(expression)) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
}
async function writeDataset(count: number) {
  const rows = Array.from({ length: count }, (_, i) => {
    const row = JSON.parse(baseUsage[i % baseUsage.length]!);
    row.requestId = `pane-bench-${i}`;
    return JSON.stringify(row);
  });
  await writeFile(join(fixture, "usage.jsonl"), rows.join("\n") + "\n");
}
async function navigate(url: string) {
  await cdp("Page.navigate", { url });
  await waitUntil("document.readyState === 'complete'");
}
async function waitUseful(title: string) {
  // Require the destination title, selected sidebar link, and nontrivial rendered main content.
  const escaped = JSON.stringify(title);
  await waitUntil(`(() => { const h=[...document.querySelectorAll('h1')].some(x=>x.textContent?.trim()===${escaped}); const a=[...document.querySelectorAll('nav a')].find(x=>x.textContent?.trim()===${escaped}); return h && a?.getAttribute('aria-current')==='page' && (document.querySelector('main')?.innerText.trim().length ?? 0)>50; })()`);
}
async function warmClick(title: string) {
  const escaped = JSON.stringify(title);
  const rect = await evaluate(`(() => { const a=[...document.querySelectorAll('a')].find(x=>x.textContent?.trim()===${escaped}); if(!a) throw Error('Missing pane link '+${escaped}); const r=a.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp("Runtime.evaluate", { expression: "performance.mark('pane-click-start'); window.__paneResourceStart=performance.now(); window.__paneLongTaskStart=window.__yaldLongTasks?.length||0" });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await waitUntil(`(() => { const h=[...document.querySelectorAll('h1')].some(x=>x.textContent?.trim()===${escaped}); const a=[...document.querySelectorAll('nav a')].find(x=>x.textContent?.trim()===${escaped}); return h && a?.getAttribute('aria-current')==='page'; })()`);
  const activeMs = await evaluate("performance.now()-window.__paneResourceStart");
  await waitUseful(title);
  const details = await evaluate(`(() => { const e=performance.getEntriesByType('resource').filter(x=>x.startTime>=window.__paneResourceStart); const resources=e.map(x=>({name:new URL(x.name).pathname,durationMs:Number(x.duration.toFixed(2)),transferBytes:x.transferSize||0})); return { usefulMs:performance.now()-window.__paneResourceStart, resources, apiResources:resources.filter(x=>x.name.startsWith('/api/')), routeChunks:resources.filter(x=>/\\/(Overview|Usage|Cost|Performance|Reliability|Models|Quota|Conversations)-[^/]+\\.js$/.test(x.name)).map(x=>x.name), rendererChunkLoaded:performance.getEntriesByType('resource').some(x=>/\\/ChartRenderer-[^/]+\\.js$/.test(new URL(x.name).pathname)), chartCanvasCount:document.querySelectorAll('main canvas').length, longTasks:(window.__yaldLongTasks||[]).slice(window.__paneLongTaskStart||0) }; })()`);
  return { activeMs: round(activeMs), ...details };
}

async function heatmapInteractionCheck() {
  await navigate(`http://127.0.0.1:${port}/usage?range=all`);
  await waitUseful("Usage");
  const pointerTarget = await evaluate(`(() => { const buttons=[...document.querySelectorAll('[aria-label^="Activity heatmap cells by weekday and hour"] button')]; const button=buttons.find(x=>Number(x.id.split('-').at(-1))<167); if(!button) return null; button.focus(); const r=button.getBoundingClientRect(); return {id:button.id,x:r.x+r.width/2,y:r.y+r.height/2,label:button.getAttribute('aria-label')}; })()`);
  if (!pointerTarget) {
    const state = await evaluate("({grid:document.querySelector('[aria-label^=\"Activity heatmap cells by weekday and hour\"]')?.innerText ?? null,buttons:[...document.querySelectorAll('[aria-label^=\"Activity heatmap cells by weekday and hour\"] button')].slice(0,4).map(x=>x.getAttribute('aria-label')),heatmap:document.querySelector('.card h2')?.parentElement?.parentElement?.innerText.slice(0,300)})");
    throw new Error(`Heatmap fixture has no nonzero keyboard cell: ${JSON.stringify(state)}`);
  }
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: pointerTarget.x, y: pointerTarget.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: pointerTarget.x, y: pointerTarget.y, button: "left", clickCount: 1 });
  await waitUntil("Boolean(document.querySelector('[aria-label=\"Selected heatmap cell dates\"]'))");
  const pointerSelected = await evaluate("document.querySelector('[aria-label=\"Selected heatmap cell dates\"] h3')?.textContent ?? ''");

  const keyboardTarget = await evaluate(`(() => { const buttons=[...document.querySelectorAll('[aria-label^="Activity heatmap cells by weekday and hour"] button')]; const button=buttons.find(x=>x.id===${JSON.stringify(pointerTarget.id)}); button?.focus(); return buttons[Math.min(167,Number(button?.id.split('-').at(-1))+1)]?.getAttribute('aria-label'); })()`);
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await waitUntil(`document.querySelector('[aria-label="Selected heatmap cell dates"] h3')?.textContent?.includes(${JSON.stringify(keyboardTarget.split(",")[0])})`);
  await waitUntil("Boolean(document.querySelector('[aria-label=\"Selected heatmap cell dates\"] h3')?.textContent?.includes('('))");
  const keyboardSelected = await evaluate("document.querySelector('[aria-label=\"Selected heatmap cell dates\"] h3')?.textContent ?? ''");
  const cardMetricButton = await evaluate(`(() => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); const card=[...document.querySelectorAll('.card')].find(x=>x.querySelector('h2')?.textContent==='Activity heatmap'); const b=[...card.querySelectorAll('button')].find(x=>x.textContent.trim()==='Requests'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (!cardMetricButton) throw new Error("Could not switch heatmap metric to requests");
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: cardMetricButton.x, y: cardMetricButton.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: cardMetricButton.x, y: cardMetricButton.y, button: "left", clickCount: 1 });
  try {
    await waitUntil("Boolean(document.querySelector('input[type=range][aria-label=\"Minimum activity in requests\"]'))");
  } catch {
    const state = await evaluate("({sliders:[...document.querySelectorAll('input[type=range]')].map(x=>x.getAttribute('aria-label')),heatmapButtons:[...document.querySelectorAll('.card')].find(x=>x.querySelector('h2')?.textContent==='Activity heatmap')?.innerText.slice(0,250),dark:document.documentElement.classList.contains('dark')})");
    throw new Error(`Heatmap metric did not switch to Requests: ${JSON.stringify(state)}`);
  }
  const requestsSlider = await evaluate("({max:Number(document.querySelector('input[type=range][aria-label=\"Minimum activity in requests\"]')?.max), reset:Number(document.querySelector('input[type=range][aria-label=\"Minimum activity in requests\"]')?.value)})");
  await evaluate("document.querySelector('input[type=range][aria-label=\"Minimum activity in requests\"]')?.focus()");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  const requestThresholdKeyboard = await evaluate("({value:Number(document.querySelector('input[type=range][aria-label=\"Minimum activity in requests\"]')?.value),label:document.querySelector('input[type=range][aria-label=\"Minimum activity in requests\"]')?.parentElement?.innerText})");
  await evaluate("(() => { if(!document.documentElement.classList.contains('dark')) { const b=[...document.querySelectorAll('button')].find(x=>x.title==='Toggle theme'); b?.click(); } return true; })()");
  await waitUntil("document.documentElement.classList.contains('dark')");
  const darkTheme = await evaluate("document.documentElement.classList.contains('dark')");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await Bun.sleep(150);
  const mobile = await evaluate("(() => {const t=document.querySelector('table'),p=t?.parentElement,r=p?.getBoundingClientRect(),s=p&&getComputedStyle(p),m=document.querySelector('main'),h=document.querySelector('header');return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,main:{width:m?.getBoundingClientRect().width,scrollWidth:m?.scrollWidth},header:{width:h?.getBoundingClientRect().width,scrollWidth:h?.scrollWidth},tableContainer:{width:r&&Math.round(r.width),clientWidth:p?.clientWidth,scrollWidth:p?.scrollWidth,overflowX:s?.overflowX}}})()");
  if (mobile.documentWidth > mobile.width) throw new Error(`Mobile layout overflows viewport: ${JSON.stringify(mobile)}`);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  return { pointerSelected, keyboardSelected, requestsSlider, requestThresholdKeyboard, darkTheme, mobile };
}

let server: ReturnType<typeof spawn> | undefined;
try {
  for (const count of sizes) {
    await writeDataset(count);
    server?.kill("SIGTERM");
    server = spawn(join(root, "scripts/bun"), ["run", "server/src/index.ts"], { cwd: root, env: { ...process.env, OCX_HOME: fixture, CLAUDE_PROJECTS_DIR: join(fixture, "claude-projects"), YALD_PORT: String(port), YALD_HOST: "127.0.0.1" }, stdio: "ignore" });
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
      if (i === 119) throw new Error("Server did not start");
      await Bun.sleep(250);
    }
    const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" }).then(r => r.json()) as { webSocketDebuggerUrl: string };
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Chrome DevTools connection failed")); });
    socket.onmessage = event => { const data = JSON.parse(String(event.data)); if (data.id && pending.has(data.id)) pending.get(data.id)!(data); };
    await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
    await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { window.__yaldLongTasks=[]; try { new PerformanceObserver(list => window.__yaldLongTasks.push(...list.getEntries().map(x=>({startTime:x.startTime,duration:x.duration})))) .observe({type:'longtask',buffered:true}); window.__yaldLongTaskSupported=true; } catch { window.__yaldLongTaskSupported=false; } })()` });
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const output: Record<string, unknown> = { fixtureRows: count, panes: {} };
    const results = output.panes as Record<string, unknown>;
    // Cold: fresh document navigation for each pane, including initial data fetch and lazy route chunk.
    for (const [title, route] of panes) {
      await cdp("Network.clearBrowserCache");
      await navigate(`http://127.0.0.1:${port}${route}`);
      await waitUseful(title);
      results[title] = {
        coldNavigationToUsefulMs: round(await evaluate("performance.now()")),
        usefulContentEvidence: await evaluate(`(() => { const resources=performance.getEntriesByType('resource'); return { apiResources:resources.filter(x=>new URL(x.name).pathname.startsWith('/api/')).map(x=>({path:new URL(x.name).pathname,durationMs:Number(x.duration.toFixed(2))})), routeChunks:resources.filter(x=>/\\/(Overview|Usage|Cost|Performance|Reliability|Models|Quota|Conversations)-[^/]+\\.js$/.test(new URL(x.name).pathname)).map(x=>new URL(x.name).pathname), rendererChunkLoaded:resources.some(x=>/\\/ChartRenderer-[^/]+\\.js$/.test(new URL(x.name).pathname)), chartCanvasCount:document.querySelectorAll('main canvas').length, longTaskSupported:window.__yaldLongTaskSupported===true, longTasks:window.__yaldLongTasks||[] }; })()`),
        coldResources: await evaluate("performance.getEntriesByType('resource').map(x=>({name:new URL(x.name).pathname,durationMs:Number(x.duration.toFixed(2)),transferBytes:x.transferSize||0}))"),
      };
    }
    // Warm: 5 measured clicks per pane, preceded by an unrecorded click to warm route code/cache.
    for (const [title] of panes) {
      const pane = results[title] as Record<string, any>;
      await warmClick("Overview");
      await warmClick(title);
      const samples: Array<{ activeMs: number; usefulMs: number; resources: unknown[]; apiResources: unknown[]; routeChunks: string[]; rendererChunkLoaded: boolean; chartCanvasCount: number; longTasks: unknown[] }> = [];
      for (let i = 0; i < 5; i++) {
        await warmClick(title === "Overview" ? "Usage" : "Overview");
        samples.push(await warmClick(title));
      }
      pane.warmClick = { samples, activeP50Ms: percentile(samples.map(x => x.activeMs), 0.5), activeP95Ms: percentile(samples.map(x => x.activeMs), 0.95), usefulP50Ms: percentile(samples.map(x => x.usefulMs), 0.5), usefulP95Ms: percentile(samples.map(x => x.usefulMs), 0.95) };
    }
    // Exercise the app's explicit refresh action and measure until the request settles.
    await cdp("Runtime.evaluate", { expression: "performance.mark('refresh-start')" });
    await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.title?.includes('Re-read')); if(!b) throw Error('Refresh control missing'); b.click(); return true; })()`);
    await waitUntil("performance.getEntriesByType('resource').some(x=>new URL(x.name).pathname==='/api/dataset/refresh' && x.responseEnd>0)");
    output.refreshMs = await evaluate("performance.now()-performance.getEntriesByName('refresh-start').at(-1).startTime");
    output.refreshRequest = await evaluate("performance.getEntriesByType('resource').filter(x=>new URL(x.name).pathname==='/api/dataset/refresh').slice(-1).map(x=>({durationMs:Number(x.duration.toFixed(2)),transferBytes:x.transferSize||0}))");
    // One visible polling interval; this can be skipped when collecting only navigation diagnostics.
    if (process.env.YALD_BENCH_SKIP_POLLING === "1") {
      output.visiblePolling31s = { skipped: true };
    } else {
      await cdp("Runtime.evaluate", { expression: "window.__apiCountBefore=performance.getEntriesByType('resource').filter(x=>new URL(x.name).pathname.startsWith('/api/')).length" });
      await Bun.sleep(31_000);
      output.visiblePolling31s = await evaluate("({apiRequests:performance.getEntriesByType('resource').filter(x=>x.startTime>performance.now()-31000 && new URL(x.name).pathname.startsWith('/api/')).map(x=>new URL(x.name).pathname), totalApiRequestDelta:performance.getEntriesByType('resource').filter(x=>new URL(x.name).pathname.startsWith('/api/')).length-window.__apiCountBefore})");
    }
    output.heatmapInteraction = await heatmapInteractionCheck();
    console.log(JSON.stringify(output));
    socket.close(); socket = undefined;
    server.kill("SIGTERM"); server = undefined;
    await Bun.sleep(250);
  }
} finally {
  socket?.close(); server?.kill("SIGTERM"); chromeProcess.kill("SIGTERM");
  await rm(scratch, { recursive: true, force: true }); await rm(fixture, { recursive: true, force: true });
}
