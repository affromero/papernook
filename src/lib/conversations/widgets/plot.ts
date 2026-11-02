import { escapeXml } from "../preview";
import { fenceCode } from "@/lib/chat/format/fence";
import { object, text, finite, list, scalar, label, table } from "./schema";

function svg(body: string, title: string): string {
  return fenceCode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 300" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title><rect width="720" height="300" rx="12" fill="#151b25"/>${body}</svg>`,
    "svg-preview",
  );
}

/** Coordinates are derived only from finite supplied values, never provider code. */
export function chartMarkdown(chart: Record<string, unknown>): string {
  const data = list(chart.data);
  const series = list(chart.series, 8)
    .map(object)
    .filter((value) => value !== null);
  const axis = chart.xKey ?? chart.xAxis;
  const axisOptions = object(axis);
  const xKey = typeof axis === "string" ? axis : text(object(axis)?.dataKey);
  if (!xKey || !series.length || !data.length)
    return "The provider did not include chart values. The saved source is available below.";
  const formatted = list(chart.formattedData);
  const columns = [
    xKey,
    ...series.map((series) => text(series.label ?? series.dataKey)),
  ];
  const rows = data.map((value, index) => {
    const point = object(value);
    return [
      scalar(point?.[xKey]),
      ...series.map((series) => {
        const key = text(series.dataKey);
        const supplied = object(formatted[index])?.[key];
        if (typeof supplied === "string") return supplied;
        const value = point?.[key];
        return value === null || value === undefined
          ? "Not provided"
          : `${scalar(series.valuePrefix)}${scalar(value)}${scalar(series.valueSuffix)}`;
      }),
    ];
  });
  const values = series.flatMap((series) =>
    data.map((point) => object(point)?.[text(series.dataKey)]).filter(finite),
  );
  const parts = [
    `### ${label(object(chart.meta)?.description) || "Saved chart"}`,
  ];
  const unsupported =
    "The saved chart style is unsupported. Its values are shown below.";
  const yAxis = object(chart.yAxis);
  const supported =
    series.every(
      (series) =>
        !series.type ||
        ["line", "area", "bar", "scatter"].includes(text(series.type)),
    ) &&
    (!chart.layout || chart.layout === "horizontal") &&
    (!yAxis?.scale || yAxis.scale === "auto" || yAxis.scale === "linear") &&
    !yAxis?.domain &&
    (!axisOptions?.scale ||
      axisOptions.scale === "auto" ||
      axisOptions.scale === "linear") &&
    (!axisOptions?.domain ||
      (Array.isArray(axisOptions.domain) &&
        axisOptions.domain.length === 2 &&
        axisOptions.domain.every(
          (value) =>
            finite(value) ||
            value === "auto" ||
            value === "dataMin" ||
            value === "dataMax",
        )));
  if (values.length && supported) {
    const numericX =
      axisOptions?.type === "number" ||
      (!axisOptions?.type &&
        series.some((series) => series.type === "scatter"));
    const xValues = data.map((point) => object(point)?.[xKey]).filter(finite);
    const domain = Array.isArray(axisOptions?.domain) ? axisOptions.domain : [];
    const xMagnitude = Math.max(
      1,
      ...[...xValues, ...domain.filter(finite)].map((value) => Math.abs(value)),
    );
    const xMinimum = finite(domain[0])
      ? domain[0] / xMagnitude
      : Math.min(...xValues) / xMagnitude;
    const xMaximum = finite(domain[1])
      ? domain[1] / xMagnitude
      : Math.max(...xValues) / xMagnitude;
    if (
      (numericX &&
        (!xValues.length ||
          xMinimum > xMaximum ||
          (finite(domain[0]) && finite(domain[1]) && xMinimum === xMaximum))) ||
      (domain.length &&
        (!numericX ||
          (!finite(domain[0]) &&
            !["auto", "dataMin"].includes(text(domain[0]))) ||
          (!finite(domain[1]) &&
            !["auto", "dataMax"].includes(text(domain[1])))))
    )
      return [...parts, unsupported, table(columns, rows)].join("\n\n");
    const xRange = xMaximum - xMinimum || 1;
    const zero = series.some(
      (series) => series.type === "bar" || series.type === "area",
    );
    const extent = zero ? [...values, 0] : values;
    const magnitude = Math.max(1, ...extent.map((value) => Math.abs(value)));
    const minimum = Math.min(...extent) / magnitude,
      maximum = Math.max(...extent) / magnitude;
    const range = maximum - minimum || 1;
    const baseline = 240 - ((0 - minimum) / range) * 195;
    const colors = ["#77bdfb", "#a5d6a7", "#f7ca80", "#d7a5ef"];
    let body = '<path d="M50 35V250H695" stroke="#8994a5" fill="none"/>';
    for (let tick = 0; tick <= 2; tick++) {
      const y = 240 - tick * 97.5;
      const value = (minimum + (range * tick) / 2) * magnitude;
      const formatted = Number.isFinite(value) ? value.toPrecision(4) : "";
      body += `<path d="M50 ${y}H695" stroke="#354356" stroke-dasharray="3 5"/><text x="45" y="${y + 4}" text-anchor="end" fill="#d7dfeb" font-size="10">${escapeXml(formatted)}</text>`;
    }
    series.forEach((series, seriesIndex) => {
      let run: string[] = [];
      const color = colors[seriesIndex % colors.length];
      function flush() {
        if (series.type === "area" && run.length > 1)
          body += `<polygon points="${run[0].split(",")[0]},${baseline} ${run.join(" ")} ${run.at(-1)!.split(",")[0]},${baseline}" fill="${color}" fill-opacity="0.25"/>`;
        if (run.length > 1)
          body += `<polyline points="${run.join(" ")}" stroke="${color}" stroke-width="2.5" fill="none"/>`;
        run = [];
      }
      data.forEach((point, index) => {
        const value = object(point)?.[text(series.dataKey)];
        const horizontal = object(point)?.[xKey];
        if (!finite(value) || (numericX && !finite(horizontal))) {
          flush();
          return;
        }
        const fraction =
          numericX && finite(horizontal)
            ? xMinimum === xMaximum
              ? 0.5
              : (horizontal / xMagnitude - xMinimum) / xRange
            : index / Math.max(1, data.length - 1);
        if (fraction < 0 || fraction > 1) {
          flush();
          return;
        }
        const x = 55 + fraction * 630;
        const y = 240 - ((value / magnitude - minimum) / range) * 195;
        if (series.type === "bar")
          body += `<rect x="${x - 4}" y="${Math.min(y, baseline)}" width="8" height="${Math.max(1, Math.abs(baseline - y))}" fill="${color}"/>`;
        else if (series.type === "scatter")
          body += `<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`;
        else {
          run.push(`${x},${y}`);
          body += `<circle cx="${x}" cy="${y}" r="2" fill="${color}"/>`;
        }
      });
      flush();
      body += `<text x="${55 + seriesIndex * 80}" y="22" fill="${color}" font-size="11">${escapeXml(text(series.label ?? series.dataKey).slice(0, 12))}</text>`;
    });
    body += `<text x="55" y="280" fill="#d7dfeb" font-size="11">${escapeXml(rows[0][0].slice(0, 55))}</text><text x="690" y="280" text-anchor="end" fill="#d7dfeb" font-size="11">${escapeXml(rows.at(-1)![0].slice(0, 55))}</text>`;
    parts.push(
      svg(body, text(object(chart.meta)?.description) || "Saved chart"),
    );
  }
  if (!supported) parts.push(unsupported);
  parts.push(table(columns, rows));
  return parts.join("\n\n");
}

export function mapMarkdown(state: Record<string, unknown>): string {
  const places = list(state.places, 100).flatMap((value) => {
    const place = object(value);
    if (!place || place.isModelPreferred === false) return [];
    if (
      typeof place.name !== "string" ||
      !finite(place.latitude) ||
      !finite(place.longitude) ||
      Math.abs(place.latitude) > 90 ||
      Math.abs(place.longitude) > 180
    )
      throw new Error("The saved map contains unsupported coordinates.");
    return [
      {
        category: place.category,
        rating: place.rating,
        price: place.price,
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
      },
    ];
  });
  if (!places.length)
    return "Map locations were not included in this share. The saved source is available below.";
  const west = Math.min(...places.map((place) => place.longitude)),
    east = Math.max(...places.map((place) => place.longitude));
  const south = Math.min(...places.map((place) => place.latitude)),
    north = Math.max(...places.map((place) => place.latitude));
  let body =
    '<path d="M40 70H680M40 150H680M40 230H680M140 40V255M360 40V255M580 40V255" stroke="#354356" fill="none"/>';
  places.forEach((place, index) => {
    const x =
      west === east
        ? 360
        : 55 + ((place.longitude - west) / (east - west)) * 610;
    const y =
      south === north
        ? 145
        : 235 - ((place.latitude - south) / (north - south)) * 180;
    body += `<circle cx="${x}" cy="${y}" r="7" fill="#77bdfb"/><text x="${x + 10}" y="${y - 10}" fill="#e2ecfa" font-size="12">${escapeXml(index + 1)}</text>`;
  });
  return [
    `### ${label(state.title) || "Saved places"}`,
    svg(body, "Saved map locations"),
    table(
      ["Place", "Latitude", "Longitude", "Details"],
      places.map((place, index) => [
        `${index + 1}. ${place.name}`,
        String(place.latitude),
        String(place.longitude),
        [
          scalar(place.category),
          finite(place.rating) ? `Rating ${place.rating}` : "",
          scalar(place.price),
        ]
          .filter(Boolean)
          .join(" · "),
      ]),
    ),
  ].join("\n\n");
}
