import { useRef, useState } from "react";
import { heatmapTotals, inHeatmapRange, type GridPoint, type GridRange } from "../lib/overviewUsage";
import { formatCompact, formatInteger, formatPercent } from "../lib/format";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

export function ActivityGrid({ cells, disabled, unit, onChoose, onClearChoice }: {
  cells: (GridPoint & { value: number; requests: number })[];
  disabled: boolean;
  unit: string;
  onChoose: (weekday: number, hour: number) => void;
  /** The dates below describe one cell, so a wider or cleared range closes them. */
  onClearChoice: () => void;
}) {
  const [focus, setFocus] = useState(0);
  const [range, setRange] = useState<GridRange | null>(null);
  const drag = useRef<GridRange | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const max = Math.max(1, ...cells.map(cell => cell.value));
  const total = cells.reduce((sum, cell) => sum + cell.value, 0);
  const totals = range ? heatmapTotals(cells, range) : null;
  const pointAt = (x: number, y: number): GridPoint | null => {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-heatmap-cell]");
    if (!element || !grid.current?.contains(element)) return null;
    const index = Number(element.dataset.heatmapCell);
    return { weekday: Math.floor(index / 24), hour: index % 24 };
  };
  return <>
    <p className="mb-2 text-[11px] text-muted">Drag to total a range, click a cell for its dates. Shift+Arrow extends the selection.</p>
    <div className="flex flex-wrap items-start gap-4">
      <div className="activity-grid-scroll min-w-0 flex-1" style={{ maxWidth: 660, minWidth: 260 }}>
      <div ref={grid} role="grid" aria-label={`Activity by weekday and hour, ${unit}`} aria-multiselectable="true" aria-disabled={disabled}
        className="activity-grid select-none"
        onPointerDown={event => {
          if (disabled || event.button !== 0) return;
          const point = pointAt(event.clientX, event.clientY);
          if (!point) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { anchor: point, end: point }; setRange(drag.current);
          const index = point.weekday * 24 + point.hour;
          setFocus(index); grid.current?.querySelector<HTMLElement>(`[data-heatmap-cell="${index}"]`)?.focus();
        }}
        onPointerMove={event => {
          if (!drag.current || disabled) return;
          const point = pointAt(event.clientX, event.clientY);
          if (point) { drag.current = { ...drag.current, end: point }; setRange(drag.current); }
        }}
        onPointerUp={event => {
          const selected = drag.current; drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (disabled || !selected) return;
          if (selected.anchor.weekday === selected.end.weekday && selected.anchor.hour === selected.end.hour) onChoose(selected.end.weekday, selected.end.hour);
          else onClearChoice();
        }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
        <div role="row" className="grid gap-0.5" style={{ gridTemplateColumns: "30px repeat(24,minmax(0,1fr))" }}>
          <span role="columnheader" aria-label="Weekday" />
          {Array.from({ length: 24 }, (_, hour) => <span key={hour} role="columnheader" aria-label={hourLabel(hour)} className="h-5 text-[9px] text-muted">{hour % 6 === 0 ? hour : ""}</span>)}
        </div>
        {DAYS.map((day, weekday) => <div role="row" key={day} className="grid gap-0.5" style={{ gridTemplateColumns: "30px repeat(24,minmax(0,1fr))", marginBottom: 2 }}>
          <span role="rowheader" className="text-[10px] text-muted">{day}</span>
          {Array.from({ length: 24 }, (_, hour) => {
            const index = weekday * 24 + hour;
            const cell = cells.find(row => row.weekday === weekday && row.hour === hour) ?? { weekday, hour, value: 0, requests: 0 };
            const selected = Boolean(range && inHeatmapRange(cell, range));
            return <button key={hour} type="button" role="gridcell" data-heatmap-cell={index} tabIndex={focus === index ? 0 : -1}
              aria-selected={selected} aria-label={`${day} ${hourLabel(hour)}, ${formatCompact(cell.value)} ${unit}, ${formatInteger(cell.requests)} requests`}
              className="h-[19px] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(8 + 92 * cell.value / max)}%, var(--surface-2))`, outline: selected ? "2px solid var(--text)" : undefined, outlineOffset: -2 }}
              onFocus={() => setFocus(index)} onClick={event => { if (!disabled && event.detail === 0) { setRange({ anchor: cell, end: cell }); onChoose(weekday, hour); } }}
              onKeyDown={event => {
                if (disabled) return;
                const moves: Record<string, GridPoint> = {
                  ArrowLeft: { weekday, hour: Math.max(0, hour - 1) }, ArrowRight: { weekday, hour: Math.min(23, hour + 1) },
                  ArrowUp: { weekday: Math.max(0, weekday - 1), hour }, ArrowDown: { weekday: Math.min(6, weekday + 1), hour },
                };
                const next = moves[event.key]; if (!next) return;
                event.preventDefault();
                setRange({ anchor: event.shiftKey ? range?.anchor ?? cell : next, end: next });
                if (event.shiftKey) onClearChoice();
                else onChoose(next.weekday, next.hour);
                const nextIndex = next.weekday * 24 + next.hour;
                setFocus(nextIndex); grid.current?.querySelector<HTMLElement>(`[data-heatmap-cell="${nextIndex}"]`)?.focus();
              }} />;
          })}
        </div>)}
      </div>
      </div>
      <div aria-live="polite" className="max-w-64 text-[12px] text-ink">
        {range && totals ? <>{DAYS[Math.min(range.anchor.weekday, range.end.weekday)]}–{DAYS[Math.max(range.anchor.weekday, range.end.weekday)]}, {hourLabel(Math.min(range.anchor.hour, range.end.hour))}–{hourLabel(Math.max(range.anchor.hour, range.end.hour) + 1)} · {formatCompact(totals.value)} {unit} · {formatPercent(total > 0 ? totals.value / total : 0, 0)} of the window · {formatInteger(totals.requests)} requests
          <button type="button" disabled={disabled} className="mt-2 block text-accent disabled:opacity-50" onClick={() => { setRange(null); onClearChoice(); }}>Clear range</button></> : "Select weekday and hour cells to total activity in this window."}
      </div>
    </div>
  </>;
}
