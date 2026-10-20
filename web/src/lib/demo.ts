interface DemoMode {
  synthetic: true;
  clock: "wall" | "fixed";
  now: number | null;
  sampleAt: number;
  pricing: string;
}

function readDemo(): DemoMode | null {
  if (typeof document === "undefined") return null;
  const raw = document.getElementById("yald-demo")?.textContent;
  if (!raw) return null;
  try { return JSON.parse(raw) as DemoMode; } catch { return null; }
}

export const DEMO = readDemo();
/** Normal pages always use the wall clock. No global Date patch. */
export const displayNow = () => DEMO?.now ?? Date.now();
