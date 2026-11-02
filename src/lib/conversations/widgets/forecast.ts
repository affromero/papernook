import { object, text, finite, list, scalar, label, table } from "./schema";
import { chartMarkdown } from "./plot";

function temperature(value: unknown, fahrenheit: boolean): string {
  const data = object(value);
  const formatted = data?.[fahrenheit ? "label_f" : "label_c"];
  if (typeof formatted === "string") return formatted;
  const numeric = data?.[fahrenheit ? "fahrenheit" : "celsius"];
  return finite(numeric)
    ? `${numeric} °${fahrenheit ? "F" : "C"}`
    : "Not provided";
}

export function weatherMarkdown(state: Record<string, unknown>): string {
  const forecast = object(state.forecast);
  if (!forecast)
    return "Weather data was not included in this share. The saved source is available below.";
  const fahrenheit = /^(f|fahrenheit)$/i.test(
    text(state.unit ?? state.initial_unit),
  );
  const current = object(forecast.current);
  const parts = [
    `### ${label(forecast.location_label ?? state.region_label) || "Saved weather"}`,
  ];
  if (current)
    parts.push(
      `**${label(temperature(current.temperature, fahrenheit))}** ${label(current.description)}`,
    );
  const daily = list(forecast.daily, 31);
  if (daily.length)
    parts.push(
      table(
        ["Day", "Conditions", "Low", "High"],
        daily.map((value) => {
          const day = object(value);
          return [
            scalar(day?.label ?? day?.date_key),
            scalar(day?.description),
            temperature(day?.low, fahrenheit),
            temperature(day?.high, fahrenheit),
          ];
        }),
      ),
    );
  const hourly = list(forecast.hourly, 168);
  if (hourly.length)
    parts.push(
      table(
        ["Hour", "Conditions", "Temperature", "Precipitation (%)"],
        hourly.map((value) => {
          const hour = object(value);
          return [
            scalar(hour?.label),
            scalar(hour?.description),
            temperature(hour?.temperature, fahrenheit),
            scalar(hour?.precip_chance) || "Not provided",
          ];
        }),
      ),
    );
  const chart = list(forecast.hourly_chart, 168);
  if (chart.length)
    parts.push(
      chartMarkdown({
        xKey: "timestamp",
        series: [
          {
            dataKey: fahrenheit ? "temp_f" : "temp_c",
            label: "Temperature",
            valueSuffix: fahrenheit ? " °F" : " °C",
          },
        ],
        data: chart,
        meta: { description: "Hourly temperatures" },
      }),
    );
  if (!current && !daily.length && !hourly.length && !chart.length)
    parts.push("Forecast values were not included in this share.");
  return parts.join("\n\n");
}
