import Plotly from "plotly.js-strict-dist-min";
import * as vega from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import { object } from "../../src/lib/conversations/formats/schema";

function isVegaLite(
  value: Record<string, unknown>,
): value is Record<string, unknown> & TopLevelSpec {
  return [
    "mark",
    "layer",
    "concat",
    "hconcat",
    "vconcat",
    "facet",
    "repeat",
  ].some((key) => Object.hasOwn(value, key));
}

function localData(value: unknown, depth = 0): void {
  if (depth > 80) throw new Error("Chart nesting exceeds the preview limit.");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("Invalid chart property.");
    if (
      /^(url|href|tiles|topojsonURL)$/.test(key) &&
      typeof child === "string" &&
      !child.startsWith("data:")
    )
      throw new Error(
        "This chart needs external data. Import a specification with its datasets included.",
      );
    if (
      key === "source" &&
      typeof child === "string" &&
      /^(https?:|\/\/)/i.test(child)
    )
      throw new Error(
        "External chart sources are unavailable in imported previews.",
      );
    localData(child, depth + 1);
  }
}

export async function renderChart(kind: string, value: unknown): Promise<void> {
  const raw =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const spec = object(raw);
  if (!spec) throw new Error("Invalid chart specification.");
  localData(spec);
  const root = document.createElement("div");
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", "Imported chart");
  document.body.append(root);
  if (kind === "plotly") {
    if (!Array.isArray(spec.data))
      throw new Error("Plotly output is missing its data traces.");
    await Plotly.newPlot(
      root,
      spec.data,
      { ...object(spec.layout), autosize: true },
      {
        responsive: true,
        displaylogo: false,
        topojsonURL: "",
        mapboxAccessToken: "",
      },
    );
    return;
  }
  let vegaSpec: vega.Spec;
  if (kind === "geojson") {
    const features =
      spec.type === "FeatureCollection" && Array.isArray(spec.features)
        ? spec.features
        : [spec];
    vegaSpec = {
      width: 640,
      height: 320,
      autosize: "fit",
      data: [{ name: "features", values: features }],
      projections: [
        {
          name: "projection",
          type: "mercator",
          fit: { signal: "data('features')" },
          size: { signal: "[width, height]" },
        },
      ],
      marks: [
        {
          type: "shape",
          from: { data: "features" },
          transform: [{ type: "geoshape", projection: "projection" }],
          encode: {
            enter: { fill: { value: "#4d92b6" }, stroke: { value: "#233b4b" } },
          },
        },
      ],
    };
  } else if (kind === "vega-lite") {
    if (!isVegaLite(spec)) throw new Error("Invalid Vega-Lite specification.");
    vegaSpec = compile(spec).spec;
  } else vegaSpec = spec as vega.Spec;
  const view = new vega.View(vega.parse(vegaSpec, undefined, { ast: true }), {
    expr: expressionInterpreter,
    renderer: "svg",
    container: root,
    hover: true,
    loader: {
      ...vega.loader(),
      load: () =>
        Promise.reject(
          new Error("External chart data is unavailable in imported previews."),
        ),
    },
  });
  await view.runAsync();
}
