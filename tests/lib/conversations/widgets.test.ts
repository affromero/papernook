import { describe, expect, it } from "vitest";
import { richMessage } from "@/lib/conversations/content";
import { widgetMarkdown } from "@/lib/conversations/widgets/render";
import {
  weatherState,
  quoteState,
  scheduleState,
  mapState,
  widgetParts,
} from "../../helpers/conversation-widgets";
import { renderMarkdown } from "@/lib/offline/render";

function snapshots(content: string): unknown[] {
  return [...content.matchAll(/```widget-preview\n([^]*?)\n```/g)].map(
    (match) => JSON.parse(match[1]) as unknown,
  );
}

describe("native saved widget states", () => {
  it("keeps exact weather labels and missing values instead of adding units or coercing null to zero", () => {
    const markdown = widgetMarkdown({ kind: "weather", state: weatherState });
    expect(markdown).toContain("12°C");
    expect(markdown).not.toContain("12°C°C");
    expect(markdown).toContain("Monday");
    expect(markdown).toContain("Not provided");
    const fahrenheit = widgetMarkdown({
      kind: "weather",
      state: { ...weatherState, unit: "f" },
    });
    expect(fahrenheit).toContain("53.6°F");
    expect(fahrenheit).not.toContain("12°C");
  });

  it("renders the supplied stock series keys, formatted metrics and quote timestamps", () => {
    const markdown = widgetMarkdown({ kind: "finance", state: quoteState });
    expect(markdown).toContain("104.25 USD");
    expect(markdown).toContain("Oct 12, 2026, 16:00 EDT");
    expect(markdown).toContain("| Volume | 0 |");
    expect(markdown).toContain("After hours");
    expect(markdown).toContain("svg-preview");
    expect(markdown).toContain("103");
  });

  it("distinguishes zero scores from scores that were not supplied", () => {
    const markdown = widgetMarkdown({ kind: "sports", state: scheduleState });
    expect(markdown).toContain("Home vs Away");
    expect(markdown).toContain("0 – Not provided");
    expect(markdown).toContain("Final");
  });

  it("renders finite coordinate maps and retains listing details", () => {
    const markdown = widgetMarkdown({ kind: "map", state: mapState });
    expect(markdown).toContain("51.5074");
    expect(markdown).toContain("Library");
    expect(markdown).toContain("Rating 4.5");
    expect(markdown).toContain("svg-preview");
    for (const value of [null, "51.5", Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        widgetMarkdown({
          kind: "map",
          state: {
            places: [{ name: "Invalid", latitude: value, longitude: 0 }],
          },
        }),
      ).toThrow("coordinates");
  });

  it("keeps identical coordinates and extreme or constant chart values finite", () => {
    const map = widgetMarkdown({
      kind: "map",
      state: {
        places: [
          { name: "A", latitude: 0, longitude: 0 },
          { name: "B", latitude: 0, longitude: 0 },
        ],
      },
    });
    for (const values of [
      [0, 0],
      [1, 1],
      [-1e308, 1e308],
    ]) {
      const chart = widgetMarkdown({
        kind: "chart",
        state: {
          xKey: "x",
          series: [{ dataKey: "y" }],
          data: values.map((y, x) => ({ x, y })),
        },
      });
      expect(chart).not.toMatch(/NaN|Infinity/);
      expect(chart).toContain("svg-preview");
    }
    expect(map).not.toMatch(/NaN|Infinity/);
  });

  it("escapes provider labels before native Markdown and generated SVG", () => {
    const hostile = "```widget-preview\n<script>parent.evil()</script>";
    const markdown = widgetMarkdown({
      kind: "weather",
      state: {
        forecast: {
          location_label: hostile,
          current: { description: hostile, temperature: { label_c: "0°C" } },
        },
      },
    });
    expect(markdown).not.toContain("\n```widget-preview");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
  });

  it("shows missing state and unsupported charts explicitly while keeping values available", () => {
    expect(widgetMarkdown({ kind: "weather", state: {} })).toContain(
      "not included",
    );
    expect(
      widgetMarkdown({
        kind: "unsupported",
        component: "FutureWidget",
        state: { value: 1 },
      }),
    ).toContain("unsupported display format");
    const chart = widgetMarkdown({
      kind: "chart",
      state: {
        xKey: "x",
        series: [{ type: "unverified", dataKey: "y" }],
        data: [{ x: 1, y: 42 }],
      },
    });
    expect(chart).toContain("style is unsupported");
    expect(chart).toContain("42");
    expect(chart).not.toContain("svg-preview");
  });
});

describe("provider display adapters", () => {
  it("excludes nested hidden state from recognized, unknown and inline widget source", () => {
    const state = {
      visible: "Public value",
      internal: { type: "reasoning", text: "PRIVATE REASONING" },
    };
    for (const component of ["WeatherWidget", "UnknownWidget"]) {
      const result = richMessage([{ type: "widget", component, state }]);
      expect(result.content).toContain("Public value");
      expect(result.content).not.toContain("PRIVATE");
    }
    const inline = richMessage(
      `<WeatherWidget __state={${JSON.stringify(state)}} />`,
    );
    expect(inline.content).toContain("Public value");
    expect(inline.content).not.toContain("PRIVATE");
    const metadata = richMessage("Gallery", {
      content_references: [
        {
          type: "image_group",
          matched_text: "Gallery",
          images: [
            {
              type: "reasoning",
              image_result: { content_url: "https://example.com/PRIVATE" },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE");
  });

  it("keeps literal examples and surrounding prose when adding provider fallback text", () => {
    const content =
      "Before.\n\n`literal`\n\n```xml\n<WeatherWidget />\n```\n\n<WeatherWidget />\n\nAfter.";
    const result = richMessage(content, {
      model_dil_v2: { fallbackMarkdown: "Saved readable response." },
    });
    expect(result.content).toContain("Saved readable response.");
    expect(result.content).toContain("```xml\n<WeatherWidget />\n```");
    expect(result.content).toContain("`literal`");
    expect(renderMarkdown(result.content)).toContain("After.");
  });

  it("preserves paragraphs and visible children following map containers", () => {
    const source = `<div data-assistant-map-payload='${JSON.stringify(mapState.places)}'>Map description</div>\nFOLLOWING VISIBLE PARAGRAPH`;
    const parsed = richMessage(source);
    const html = renderMarkdown(parsed.content);
    expect(html).toContain("FOLLOWING VISIBLE PARAGRAPH");
    expect(html).toContain("Map description");
    expect(html).toContain("Library");
  });

  it("recognizes saved producer aliases and keeps fallback quote labels", () => {
    for (const name of [
      "StockChart",
      "WeatherWidgetV3WithSource",
      "NbaScheduleWidgetWithSource",
      "CurrencyConverterV2WidgetWithSource",
    ]) {
      const result = richMessage(`<${name} __state='{}' />`);
      expect(snapshots(result.content)).toHaveLength(1);
    }
    const markdown = widgetMarkdown({
      kind: "finance",
      state: {
        current_price_text: "$42",
        fallback_summary: {
          price_change_text: "+$2",
          trade_date_text: "Saved yesterday",
        },
      },
    });
    expect(renderMarkdown(markdown)).toContain("+$2");
    expect(markdown).toContain("Saved yesterday");
  });

  it("plots numeric scatter distances and reports unsupported orientation", () => {
    const chart = {
      xKey: "x",
      series: [{ dataKey: "y", type: "scatter" }],
      data: [
        { x: 0, y: 1 },
        { x: 1, y: 2 },
        { x: 10, y: 3 },
      ],
    };
    const markdown = widgetMarkdown({ kind: "chart", state: chart });
    const positions = [...markdown.matchAll(/<circle cx="([^"]+)"/g)].map(
      (match) => Number(match[1]),
    );
    expect(
      (positions[2] - positions[1]) / (positions[1] - positions[0]),
    ).toBeCloseTo(9);
    const vertical = widgetMarkdown({
      kind: "chart",
      state: { ...chart, layout: "vertical" },
    });
    expect(vertical).toContain("style is unsupported");
    expect(vertical).not.toContain("svg-preview");
    const extreme = widgetMarkdown({
      kind: "chart",
      state: {
        ...chart,
        xAxis: { dataKey: "x", type: "number", domain: [-1e308, 1e308] },
        xKey: undefined,
      },
    });
    const centered = [...extreme.matchAll(/<circle cx="([^"]+)"/g)].map(
      (match) => Number(match[1]),
    );
    expect(centered).toHaveLength(3);
    for (const position of centered) expect(position).toBeCloseTo(370);
    const reversed = widgetMarkdown({
      kind: "chart",
      state: {
        ...chart,
        xAxis: { dataKey: "x", type: "number", domain: [10, 0] },
        xKey: undefined,
      },
    });
    expect(reversed).toContain("style is unsupported");
    expect(reversed).not.toContain("svg-preview");
  });

  it("preserves resolved native states and their source in ordinary transcript imports", () => {
    const parsed = richMessage(widgetParts);
    const values = snapshots(parsed.content);
    expect(values).toHaveLength(4);
    expect(values[0]).toMatchObject({ kind: "weather", state: weatherState });
    expect(values[1]).toMatchObject({ kind: "finance", state: quoteState });
  });

  it("resolves only an explicitly named component result and never discovers private nested data", () => {
    const content = '<WeatherWidget __resolutionId="weather-1" />';
    const resolved = richMessage(content, {
      opGenui: {
        componentResults: {
          "weather-1": { __state: weatherState },
          other: { __state: { forecast: { location_label: "PRIVATE OTHER" } } },
        },
      },
    });
    expect(snapshots(resolved.content)[0]).toMatchObject({
      state: weatherState,
    });
    expect(resolved.content).not.toContain("PRIVATE");
    const omitted = richMessage(content, {
      nested: { forecast: { location_label: "PRIVATE NESTED" } },
      model_dil_v2: {
        fallbackMarkdown: "The provider's saved readable response.",
      },
    });
    expect(omitted.content).toContain("saved readable response");
    expect(omitted.content).not.toContain("PRIVATE");
    const hidden = richMessage(content, {
      opGenui: {
        componentResults: {
          "weather-1": { type: "thinking", __state: weatherState },
        },
      },
    });
    expect(snapshots(hidden.content)[0]).toMatchObject({ state: {} });
  });

  it("parses literal JSON state without evaluating JSX or changing code examples", () => {
    const tag = `<WeatherWidget.V3 __state={${JSON.stringify(weatherState)}} />`;
    const content = `\`\`\`xml\n${tag}\n\`\`\`\n\n${tag}\n\n\`${tag}\``;
    const parsed = richMessage(content);
    expect(snapshots(parsed.content)).toHaveLength(1);
    expect(parsed.content).toContain(`\`\`\`xml\n${tag}\n\`\`\``);
    expect(parsed.content).toContain(`\`${tag}\``);
    const expression = richMessage(
      "<WeatherWidget __state={stealCookies()} />",
    );
    expect(snapshots(expression.content)[0]).toMatchObject({ state: {} });
    expect(expression.content).toContain("stealCookies()");
  });

  it("keeps image-group assets and search cards instead of exposing internal control markers", () => {
    const marker = "\uE200image_group\uE202fixture\uE201";
    const result = richMessage(marker, {
      content_references: [
        {
          type: "image_group",
          matched_text: marker,
          start_idx: 0,
          end_idx: marker.length,
          images: [
            {
              image_result: {
                title: "Example image",
                url: "https://example.com/page",
                content_url: "https://images.example/result.png",
              },
            },
          ],
        },
      ],
    });
    expect(result.assets).toMatchObject([
      { kind: "image", url: "https://images.example/result.png" },
    ]);
    const markdown = widgetMarkdown(
      snapshots(result.content)[0],
      result.assets,
    );
    expect(markdown).toContain("#asset-0");
    expect(markdown).toContain("https://example.com/page");
    const nav = "\uE200navlist\uE202sources\uE201";
    const search = richMessage(nav, {
      content_references: [
        {
          type: "nav_list",
          matched_text: nav,
          items: [
            { title: "Research source", url: "https://example.com/source" },
          ],
        },
      ],
    });
    expect(widgetMarkdown(snapshots(search.content)[0])).toContain(
      "Research source",
    );
  });

  it("replaces markers once without rewriting a later marker inside retained chart source", () => {
    const first = "\uE200genui\uE202A\uE201",
      second = "\uE200genui\uE202B\uE201";
    const content = first + "\n\n" + second;
    const ref = (marker: string, start: number, description: string) => ({
      type: "client_defined_widget",
      matched_text: marker,
      start_idx: start,
      data: {
        widget_type: "charts_widget_v2",
        content: {
          meta: { description },
          xKey: "x",
          series: [{ dataKey: "y" }],
          data: [{ x: 0, y: 1 }],
        },
      },
    });
    const result = richMessage(content, {
      content_references: [
        ref(first, 0, second),
        ref(second, first.length + 2, "Second chart"),
      ],
    });
    expect(snapshots(result.content)).toHaveLength(2);
    expect(snapshots(result.content)[0]).toMatchObject({
      state: { meta: { description: second } },
    });
  });

  it("finds an unambiguous prose marker while leaving identical literal code untouched", () => {
    const marker = "\uE200genui\uE202example\uE201";
    const content = `\`${marker}\`\n\n${marker}`;
    const result = richMessage(content, {
      content_references: [
        {
          type: "client_defined_widget",
          matched_text: marker,
          data: {
            widget_type: "charts_widget_v2",
            content: {
              xKey: "x",
              series: [{ dataKey: "y" }],
              data: [{ x: 1, y: 2 }],
            },
          },
        },
      ],
    });
    expect(result.content).toContain(`\`${marker}\``);
    expect(snapshots(result.content)).toHaveLength(1);
  });

  it("uses explicitly scoped component metadata and preserves exported source lists", () => {
    const content = '<WeatherWidget __resolutionId="captured-weather" />';
    const result = richMessage(content, {
      genui_components: [
        {
          type: "WeatherWidget",
          start_index: 0,
          end_index: content.length,
          props: { __state: weatherState },
        },
      ],
      content_references: [
        {
          type: "sources_footnote",
          sources: [
            { title: "Forecast source", url: "https://example.com/forecast" },
          ],
        },
      ],
    });
    expect(snapshots(result.content)[0]).toMatchObject({
      kind: "weather",
      state: weatherState,
    });
    expect(result.citations).toMatchObject([
      { title: "Forecast source", url: "https://example.com/forecast" },
    ]);
    expect(widgetMarkdown(snapshots(result.content)[1])).toContain(
      "Forecast source",
    );
  });

  it("renders exported math widgets and supports map payload attributes", () => {
    const marker = "\uE200genui\uE202math\uE201";
    const math = richMessage(marker, {
      content_references: [
        {
          type: "client_defined_widget",
          matched_text: marker,
          data: {
            widget_type: "math_block_widget_always_prefetch_v2",
            content: "y = mx + b",
          },
        },
      ],
    });
    expect(math.content).toContain("$$\ny = mx + b\n$$");
    const map = richMessage(
      `<div data-assistant-map-payload='${JSON.stringify(mapState.places)}'></div>`,
    );
    expect(snapshots(map.content)[0]).toMatchObject({
      kind: "map",
      state: { places: mapState.places },
    });
  });

  it("bounds state, references, generated content and attachment expansion", () => {
    expect(() =>
      richMessage("x", {
        content_references: Array.from({ length: 1001 }, () => ({})),
      }),
    ).toThrow("row limit");
    expect(() =>
      widgetMarkdown({
        kind: "chart",
        state: { data: Array.from({ length: 501 }, () => ({ x: 1, y: 2 })) },
      }),
    ).toThrow("row limit");
    expect(() =>
      richMessage([
        {
          type: "widget",
          component: "WeatherWidget",
          state: { large: "x".repeat(300_001) },
        },
      ]),
    ).toThrow("source limit");
  });

  it("exports native values, charts, maps and source without scripts or remote requests", () => {
    const parsed = richMessage(widgetParts);
    const html = renderMarkdown(parsed.content, { assets: parsed.assets });
    expect(html).toContain("Example City");
    expect(html).toContain("104.25 USD");
    expect(html).toContain("0 – Not provided");
    expect(html).toContain("Library");
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain("Display source");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
  });

  it("surfaces malformed widget data in portable exports while retaining its source", () => {
    const parsed = richMessage([
      {
        type: "widget",
        component: "MapWidget",
        state: {
          places: [{ name: "Invalid location", latitude: null, longitude: 0 }],
        },
      },
    ]);
    const html = renderMarkdown(parsed.content);
    expect(html).toContain("Saved widget could not be rendered");
    expect(html).toContain("unsupported coordinates");
    expect(html).toContain("Invalid location");
    expect(html).toContain("Display source");
  });
});
