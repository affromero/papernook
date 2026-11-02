import { object, text, list, scalar, label, table } from "./schema";
import { chartMarkdown } from "./plot";

export function financeMarkdown(state: Record<string, unknown>): string {
  const parts = [`### ${label(state.asset_display_name) || "Saved quote"}`];
  if (typeof state.current_price_text === "string")
    parts.push(`**${label(state.current_price_text)}**`);
  const configurations = object(state.timeframe_configs);
  const ranges = list(state.timeframe_order, 20);
  const selected = text(state.default_range) || text(ranges[0]);
  const configuration = object(configurations?.[selected]);
  const summary =
    object(configuration?.summary) ?? object(state.fallback_summary);
  if (summary)
    parts.push(
      [label(summary.price_change_text), label(summary.trade_date_text)]
        .filter(Boolean)
        .join(" · "),
    );
  const chart = object(configuration?.chart);
  if (chart)
    parts.push(chartMarkdown({ ...chart, xAxis: chart.xAxis ?? "timestamp" }));
  const metrics = list(state.metrics_display, 40).flatMap((row) =>
    list(object(row)?.cols, 10).map((value) => {
      const metric = object(value);
      return [scalar(metric?.label), scalar(metric?.value)];
    }),
  );
  if (metrics.length) parts.push(table(["Metric", "Value"], metrics));
  const after = object(state.after_hours);
  if (after)
    parts.push(
      `**${label(after.label) || "After hours"}** ${[label(after.price_text), label(after.change_text), label(after.percent_text)].filter(Boolean).join(" · ")}`,
    );
  if (!state.current_price_text && !chart && !metrics.length)
    parts.push(
      "Quote values were not included in this share. The saved source is available below.",
    );
  return parts.join("\n\n");
}

export function sportsMarkdown(state: Record<string, unknown>): string {
  const rows: string[][] = [];
  for (const value of list(state.rows, 100)) {
    const row = object(value);
    for (const value of list(row?.games, 40)) {
      const game = object(object(value)?.game);
      if (!game) continue;
      const teams = list(game.teams, 4)
        .map(object)
        .filter((team) => team !== null);
      const names = teams.map((team) => scalar(team.name));
      const scores = teams.map((team) =>
        team.hasScore === true
          ? scalar(team.score) || "Not provided"
          : "Not provided",
      );
      rows.push([
        scalar(row?.label ?? row?.dateLabel),
        names.join(" vs "),
        scores.join(" – "),
        [
          scalar(game.primaryLabel),
          scalar(game.secondaryLabel),
          scalar(game.liveLabel),
          scalar(game.liveDetail),
        ]
          .filter(Boolean)
          .join(" · "),
      ]);
    }
  }
  return rows.length
    ? `### ${label(state.title) || "Saved schedule"}\n\n${table(["Date", "Match", "Score", "Status"], rows)}`
    : "The provider did not include schedule entries. The saved source is available below.";
}
