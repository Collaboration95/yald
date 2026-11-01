export const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function motionDuration(token: "fast" | "normal" | "enter"): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--motion-${token}`);
  return reducedMotion() ? 0 : Number.parseFloat(value) || 0;
}
