import * as React from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  Pie,
  PieChart as RechartsPieChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import type { Lang } from "@/lib/i18n";

/** Read a themed colour so the charts follow light/dark and the palette. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Colours shared by every chart, taken from the app's own tokens. */
export function chartPalette() {
  return {
    red: token("--red", "#c4553f"),
    green: token("--green", "#4a7c59"),
    accent: token("--accent", "#4a6b8a"),
    amber: token("--amber", "#b8894a"),
    hairline: token("--hairline", "rgba(0,0,0,0.1)"),
    surface: token("--surface", "#f2f0ec"),
    panel: token("--panel", "#faf8f5"),
    ink: token("--foreground", "#2a2622"),
    muted: token("--muted-foreground", "#7a736b"),
  };
}

interface TrendDatum {
  index: number;
  value: number;
  label: string;
}

/** Trend chart using Recharts. The parent owns the values and the period
 *  switch; this component only renders and reports pointer interaction. */
export function TrendChart({
  values,
  kind,
  range,
  lang,
  formatCents,
  formatCompact,
  onSelect,
}: {
  values: number[];
  kind: "bar" | "line";
  range: "month" | "year";
  lang: Lang;
  formatCents: (value: number, lang: Lang) => string;
  formatCompact: (value: number, lang?: string) => string;
  onSelect?: (index: number) => void;
}) {
  const palette = React.useMemo(() => chartPalette(), []);
  const data: TrendDatum[] = values.map((value, index) => ({
    index,
    value,
    label: range === "year" ? `${index + 1} 月` : `${index + 1} 日`,
  }));

  return (
    <ResponsiveContainer width="100%" height={170}>
      <ComposedChart
        data={data}
        margin={{ top: 16, right: 14, bottom: 2, left: 0 }}
        // Recharts focuses its own wrapper on click, which painted a ring around
        // the plot; the parent already owns keyboard navigation for the table
        // below, so the chart is pointer-only.
        accessibilityLayer={false}
        onClick={(state) => {
          const index = (state as { activeTooltipIndex?: number })?.activeTooltipIndex;
          if (typeof index === "number") onSelect?.(index);
        }}
      >
        <CartesianGrid vertical={false} stroke={palette.hairline} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={{ stroke: palette.hairline }}
          tick={{ fill: palette.muted, fontSize: 10 }}
          interval={range === "year" ? 0 : Math.max(0, Math.floor(values.length / 10))}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fill: palette.muted, fontSize: 10 }}
          tickFormatter={(value: number) => formatCompact(value, lang)}
          width={40}
        />
        <Tooltip
          cursor={{ stroke: palette.hairline, strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            const item = payload?.[0]?.payload as TrendDatum | undefined;
            if (!active || !item) return null;
            return (
              <div
                className="rounded-[5px] border border-hairline px-2 py-1 text-[11px] shadow-[var(--shadow-md)]"
                style={{ background: palette.panel, color: palette.ink }}
              >
                {item.label}
                <br />
                {formatCents(item.value, lang)}
              </div>
            );
          }}
        />
        {kind === "bar" ? (
          <Bar
            dataKey="value"
            fill={palette.red}
            radius={[2, 2, 0, 0]}
            maxBarSize={22}
            isAnimationActive={false}
            // The chart-level handler needs a live tooltip; a bar click is
            // direct, so a day/month click always lands.
            className="recharts-clickable-datum"
            onClick={(_data, index) => onSelect?.(index)}
          />
        ) : (
          <Line
            type="monotone"
            dataKey="value"
            stroke={palette.red}
            strokeWidth={2}
            dot={{ r: 3, fill: palette.panel, stroke: palette.red, strokeWidth: 1.5 }}
            activeDot={{ r: 4, fill: palette.panel, stroke: palette.red, strokeWidth: 2 }}
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Donut chart with a legend supplied by the caller. */
export function CategoryPie({
  rows,
  lang,
  formatCents,
  onSelect,
  height = 190,
}: {
  rows: Array<{ category: string; total: number; share: number }>;
  lang: Lang;
  formatCents: (value: number, lang: Lang) => string;
  onSelect?: (category: string) => void;
  /** Charts that sit beside another card pass a smaller height so both line up. */
  height?: number;
}) {
  const palette = React.useMemo(() => chartPalette(), []);
  const data = rows.filter((row) => row.total > 0);
  const colors = [palette.accent, palette.red, palette.green, palette.amber, palette.accent, palette.red];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsPieChart>
        <Pie
          data={data}
          dataKey="total"
          nameKey="category"
          innerRadius="58%"
          outerRadius="80%"
          paddingAngle={0}
          strokeWidth={0}
          isAnimationActive={false}
          onClick={(_, index) => {
            const row = data[index];
            if (row) onSelect?.(row.category);
          }}
        >
          {data.map((row, index) => (
            <Cell key={row.category} fill={colors[index % colors.length]} />
          ))}
        </Pie>
        <Tooltip
          content={({ active, payload }) => {
            const row = payload?.[0]?.payload as { category: string; total: number } | undefined;
            if (!active || !row) return null;
            const total = data.reduce((sum, item) => sum + item.total, 0);
            return (
              <div
                className="rounded-[5px] border border-hairline px-2 py-1 text-[11px] shadow-[var(--shadow-md)]"
                style={{ background: palette.panel, color: palette.ink }}
              >
                {row.category}
                <br />
                {formatCents(row.total, lang)} · {total ? Math.round((row.total / total) * 100) : 0}%
              </div>
            );
          }}
        />
      </RechartsPieChart>
    </ResponsiveContainer>
  );
}

export { cn };
