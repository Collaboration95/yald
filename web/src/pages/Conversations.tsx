import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Badge, Card, CardHeader, Legend, ModelTag, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { donutChart, lineChart } from "../components/chartOptions";
import { colorAt } from "../lib/palette";
import { formatCompact, formatDateTime, formatDuration, formatInteger, formatRelative, shortId } from "../lib/format";
import type { ConversationDetailResponse, ConversationsResponse } from "../types";

export function ConversationsPage() {
  const { search } = useLocation();
  const { filters } = useFilters();
  const [sort, setSort] = useState<"tokens" | "cost" | "requests" | "recent" | "errors">("tokens");
  const query = useEndpoint<ConversationsResponse>("/api/conversations", filters, { sort, limit: 200 });
  const data = query.data;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Conversations" value={data ? formatInteger(data.totals.conversations) : "—"} hint="Sessions with a conversation id" icon={<MessagesSquare size={13} />} />
        <Stat label="Attributed requests" value={data ? formatInteger(data.totals.requests) : "—"} hint={data ? formatInteger(data.totals.unattributed) + " rows without an id" : undefined} tone="info" />
        <Stat label="Median requests" value={data?.totals.medianRequests ? data.totals.medianRequests.toFixed(0) : "—"} hint="Per conversation" />
        <Stat label="Median tokens" value={data?.totals.medianTokens ? formatCompact(data.totals.medianTokens) : "—"} hint="Per conversation" tone="good" />
      </div>

      <Card>
        <CardHeader
          title="Sessions ranked"
          subtitle="Every conversation opencodex correlated, biggest first"
          action={
            <div className="flex items-center gap-1">
              {(["tokens", "cost", "requests", "recent", "errors"] as const).map(option => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setSort(option)}
                  className={
                    "rounded-lg px-2 py-1 text-[11px] font-medium transition " +
                    (sort === option ? "bg-surface-3 text-ink" : "text-muted hover:text-ink-soft")
                  }
                >
                  {option}
                </button>
              ))}
            </div>
          }
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.conversations.length === 0}>
          <TableShell className="max-h-[640px] overflow-y-auto">
            <thead>
              <tr>
                <Th>Conversation</Th>
                <Th>Models</Th>
                <Th align="right">Req</Th>
                <Th align="right">Tokens</Th>
                <Th align="right">Cost</Th>
                <Th align="right">Span</Th>
                <Th align="right">Tok/hr</Th>
                <Th align="right">Errors</Th>
                <Th align="right">Last seen</Th>
              </tr>
            </thead>
            <tbody>
              {data?.conversations.map(conversation => (
                <tr key={conversation.id} className="transition hover:bg-surface-2">
                  <Td>
                    <Link to={{ pathname: "/conversations/" + conversation.id, search }} className="font-mono text-[11px] text-info hover:underline">
                      {shortId(conversation.id, 14)}
                    </Link>
                  </Td>
                  <Td className="max-w-[240px]">
                    <span className="flex flex-wrap gap-1">
                      {conversation.models.slice(0, 2).map(model => (
                        <span key={model} className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-soft">{model}</span>
                      ))}
                      {conversation.models.length > 2 ? <span className="text-[10px] text-muted">+{conversation.models.length - 2}</span> : null}
                    </span>
                  </Td>
                  <Td align="right">{formatInteger(conversation.requests)}</Td>
                  <Td align="right">{formatCompact(conversation.tokens)}</Td>
                  <Td align="right">{conversation.cost > 0 ? "$" + conversation.cost.toFixed(2) : "—"}</Td>
                  <Td align="right">{formatDuration(conversation.spanMs)}</Td>
                  <Td align="right">{formatCompact(conversation.intensity)}</Td>
                  <Td align="right" className={conversation.errors > 0 ? "text-bad" : undefined}>{conversation.errors || "—"}</Td>
                  <Td align="right" className="text-muted">{formatRelative(conversation.endedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </StateBlock>
      </Card>
    </div>
  );
}

export function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { chartTheme } = useTheme();
  const { search } = useLocation();
  const ROW_LIMIT = 150;
  const query = useEndpoint<ConversationDetailResponse>("/api/conversations/" + (id ?? ""), { range: "all", providers: [], models: [], efforts: [], statuses: [], groupBy: "model", metric: "tokens", bucket: "auto", search: "" }, {});
  const data = query.data;

  const cumulativeOption = useMemo(() => {
    if (!data || data.points.length === 0) return null;
    const labels = data.points.map(point => new Date(point.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }));
    return lineChart(chartTheme, labels, [
      { name: "cumulative tokens", data: data.points.map(point => point.cumulative), area: true },
      { name: "input (context)", data: data.points.map(point => point.contextTokens), dashed: true },
    ], { formatter: value => formatCompact(value) });
  }, [data, chartTheme]);

  const modelOption = useMemo(() => {
    if (!data) return null;
    return donutChart(chartTheme, data.models.map(model => ({ name: model.name, value: model.value })), {
      formatter: value => formatInteger(value),
      centerValue: formatInteger(data.models.reduce((sum, model) => sum + model.value, 0)),
      centerLabel: "requests",
    });
  }, [data, chartTheme]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Link to={{ pathname: "/conversations", search }} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11.5px] font-medium text-ink-soft transition hover:border-line-strong">
          <ArrowLeft size={12} /> All conversations
        </Link>
        <span className="truncate font-mono text-[11.5px] text-muted">{id}</span>
      </div>

      {data ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Requests" value={formatInteger(data.summary.requests)} hint="in this session" />
          <Stat label="Tokens" value={formatCompact(data.summary.tokens.total)} hint={formatCompact(data.summary.tokens.cacheRead) + " cached"} tone="good" />
          <Stat label="Cost" value={data.summary.cost > 0 ? "$" + data.summary.cost.toFixed(2) : "—"} hint={formatInteger(data.summary.unpricedRequests) + " unpriced"} tone="good" />
          <Stat label="Span" value={formatDuration(data.points[data.points.length - 1]!.ts - data.points[0]!.ts)} hint={formatDateTime(data.points[0]!.ts) + " start"} icon={<MessagesSquare size={13} />} />
          <Stat label="Median latency" value={formatDuration(data.summary.latency.p50)} hint={"p95 " + formatDuration(data.summary.latency.p95)} tone="info" />
          <Stat label="Errors" value={formatInteger(data.summary.errors + data.summary.cancelled)} hint={formatInteger(data.summary.errors) + " failed"} tone={data.summary.errors > 0 ? "bad" : "neutral"} />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Token growth" subtitle="Cumulative tokens vs the context window submitted on each request" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!cumulativeOption}>
            {cumulativeOption ? <Chart option={cumulativeOption} height={280} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Models used" subtitle="Requests per model in this session" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.models.length === 0}>
            <div className="flex flex-col items-center gap-3">
              {modelOption ? <Chart option={modelOption} height={180} className="max-w-[200px]" /> : null}
              <Legend items={(data?.models ?? []).map((model, index) => ({ label: model.name, color: colorAt(index), value: formatInteger(model.value) }))} />
            </div>
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Requests in this conversation"
          subtitle={
            data && data.requests.length > ROW_LIMIT
              ? `Showing the newest ${ROW_LIMIT} of ${formatInteger(data.requests.length)} requests`
              : "Chronological, with per-request context size"
          }
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.requests.length === 0}>
          <TableShell className="max-h-[520px] overflow-y-auto">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Model</Th>
                <Th align="right">Input</Th>
                <Th align="right">Cached</Th>
                <Th align="right">Output</Th>
                <Th align="right">Cost</Th>
                <Th align="right">TTFT</Th>
                <Th align="right">Total</Th>
                <Th align="center">Status</Th>
              </tr>
            </thead>
            <tbody>
              {[...(data?.requests ?? [])].reverse().slice(0, ROW_LIMIT).map(row => (
                <tr key={row.id} className="transition hover:bg-surface-2">
                  <Td className="whitespace-nowrap text-muted">{formatDateTime(row.ts)}</Td>
                  <Td><ModelTag model={row.model} provider={row.provider} className="max-w-[210px]" /></Td>
                  <Td align="right">{formatCompact(row.inputTokens)}</Td>
                  <Td align="right">{formatCompact(row.cacheReadTokens)}</Td>
                  <Td align="right">{formatCompact(row.outputTokens)}</Td>
                  <Td align="right">{row.priced ? "$" + row.cost.toFixed(4) : "—"}</Td>
                  <Td align="right">{formatDuration(row.ttftMs)}</Td>
                  <Td align="right">{formatDuration(row.durationMs)}</Td>
                  <Td align="center">
                    {row.outcome === "ok"
                      ? <Badge tone="good">ok</Badge>
                      : row.outcome === "cancelled"
                        ? <Badge tone="warn">closed</Badge>
                        : <Badge tone="bad">{row.status}</Badge>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </StateBlock>
      </Card>
    </div>
  );
}
