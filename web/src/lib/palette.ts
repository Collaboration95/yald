export const PALETTE = [
  "#16a34a",
  "#2563eb",
  "#7c3aed",
  "#f59e0b",
  "#0ea5e9",
  "#e11d48",
  "#14b8a6",
  "#a855f7",
  "#f97316",
  "#64748b",
];

export const OUTCOME_COLORS: Record<string, string> = {
  ok: "#16a34a",
  error: "#dc2626",
  cancelled: "#f59e0b",
};

export const COMPOSITION_COLORS: Record<string, string> = {
  "Fresh input": "#2563eb",
  "Cache read": "#16a34a",
  "Cache write": "#7c3aed",
  Output: "#f59e0b",
};

export function colorAt(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}
