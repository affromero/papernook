import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";
import { buildSync } from "esbuild";
const sdkEntry = require.resolve("@modelcontextprotocol/ext-apps");

const sdk = buildSync({
  stdin: {
    contents: `import {z} from "zod/v4"; z.config({jitless:true});
import(${JSON.stringify(sdkEntry)}).then(({App})=>{
const app=new App({name:"saved-display",version:"1"},{},{autoResize:false});
app.ontoolresult=(result)=>document.querySelector("#sdk-result").textContent=result.structuredContent.answer;
document.querySelector("#sdk-action").onclick=async()=>{try{await app.callServerTool({name:"write_account",arguments:{}});document.querySelector("#sdk-action").textContent="Unexpected access";}catch{document.querySelector("#sdk-action").textContent="Host actions unavailable";}};
app.connect().catch(error=>document.querySelector("#sdk-result").textContent=error.message);});`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
}).outputFiles[0].text;

for (const width of [1440, 390]) {
  test(`saved output formats render inside isolated previews at ${width}px`, async ({
    page,
    browserName,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await restoreMayaSession(page);
    const response = await page.request.post("/api/v1/conversations", {
      data: {
        format: "json",
        content: JSON.stringify({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "artifact",
                  mime_type: "application/vnd.ant.react",
                  content:
                    'import React, { useState } from "react"; import { createPortal } from "react-dom"; import { LineChart, Line } from "recharts"; export default function App(){ const [count,setCount]=useState(0); return <div className="p-4 bg-sky-100"><button onClick={()=>setCount(count+1)}>Count {count}</button>{createPortal(<p>Portal rendered</p>,document.body)}<LineChart width={260} height={100} data={[{value:1},{value:3}]}><Line dataKey="value" isAnimationActive={false}/></LineChart></div>; }',
                },
                {
                  output_type: "display_data",
                  data: {
                    "text/html": [
                      "<table><tr><th>Score</th></tr>",
                      "<tr><td>42</td></tr></table>",
                    ],
                    "text/plain": "Score: 42",
                  },
                  metadata: {},
                },
                {
                  output_type: "execute_result",
                  data: {
                    "application/vnd.plotly.v1+json": {
                      data: [{ type: "bar", x: ["Road", "Scene"], y: [2, 4] }],
                      layout: { height: 250 },
                    },
                  },
                  metadata: {},
                },
                {
                  type: "vega-lite",
                  spec: {
                    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
                    data: {
                      values: [
                        { name: "Road", value: 2 },
                        { name: "Scene", value: 4 },
                      ],
                    },
                    mark: "bar",
                    encoding: {
                      x: { field: "name", type: "nominal" },
                      y: { field: "value", type: "quantitative" },
                    },
                  },
                },
                {
                  type: "geojson",
                  data: {
                    type: "Feature",
                    properties: { name: "Test area" },
                    geometry: {
                      type: "Polygon",
                      coordinates: [
                        [
                          [0, 0],
                          [1, 0],
                          [1, 1],
                          [0, 1],
                          [0, 0],
                        ],
                      ],
                    },
                  },
                },
                {
                  output_type: "display_data",
                  data: {
                    "application/vnd.jupyter.widget-view+json": {
                      model_id: "slider",
                      version_major: 2,
                    },
                  },
                  widgetState: {
                    state: {
                      slider: {
                        model_name: "IntSliderModel",
                        model_module: "@jupyter-widgets/controls",
                        state: {
                          description: "Threshold",
                          value: 4,
                          min: 0,
                          max: 10,
                        },
                      },
                    },
                  },
                },
                {
                  type: "AdaptiveCard",
                  version: "1.5",
                  body: [
                    { type: "TextBlock", text: "Saved card heading" },
                    {
                      type: "FactSet",
                      facts: [{ title: "Status", value: "Done" }],
                    },
                    {
                      type: "Table",
                      rows: [
                        {
                          type: "TableRow",
                          cells: [
                            {
                              type: "TableCell",
                              items: [
                                { type: "TextBlock", text: "Table value 42" },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                  actions: [
                    {
                      type: "Action.Submit",
                      title: "Submit to account",
                      data: { unsafe: true },
                    },
                  ],
                },
                {
                  type: "resource",
                  resource: {
                    uri: "ui://example/report.html",
                    mimeType: "text/html;profile=mcp-app",
                    text: '<p id="saved-result"></p><script>document.getElementById("saved-result").textContent=window.openai.toolOutput.answer</script>',
                  },
                  structuredContent: { answer: "Saved tool result" },
                },
                {
                  type: "resource",
                  resource: {
                    uri: "ui://example/sdk.html",
                    mimeType: "text/html;profile=mcp-app",
                    text: '<p id="sdk-result"></p><button id="sdk-action">Attempt host action</button>',
                  },
                  structuredContent: { answer: "Actual MCP SDK saved result" },
                },
                {
                  type: "code",
                  language: "threejs",
                  code: "const scene=new THREE.Scene();scene.background=new THREE.Color(0xff0000);const camera=new THREE.OrthographicCamera(-1,1,1,-1,0.1,10);camera.position.z=2;const renderer=new THREE.WebGLRenderer();renderer.setSize(128,64);document.body.append(renderer.domElement);renderer.render(scene,camera);",
                },
                {
                  type: "vega",
                  spec: {
                    $schema: "https://vega.github.io/schema/vega/v6.json",
                    width: 200,
                    height: 100,
                    data: [
                      { name: "table", values: [{ value: 42 }] },
                      {
                        name: "derived",
                        source: "table",
                        transform: [
                          {
                            type: "formula",
                            expr: "datum.value + 1",
                            as: "score",
                          },
                        ],
                      },
                    ],
                    marks: [
                      {
                        type: "text",
                        from: { data: "derived" },
                        encode: {
                          enter: {
                            x: { value: 20 },
                            y: { value: 40 },
                            text: { field: "score" },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const { conversation } = await response.json();
    try {
      await page.goto(`/conversations/${conversation.id}`);
      const reactFrame = page.locator('iframe[title="React artifact"]');
      await reactFrame.scrollIntoViewIfNeeded();
      const react = reactFrame.contentFrame();
      await react.getByRole("button", { name: "Count 0" }).click();
      await expect(
        react.getByRole("button", { name: "Count 1" }),
      ).toBeVisible();
      await expect(react.locator("svg.recharts-surface")).toBeVisible();
      await expect(react.getByText("Portal rendered")).toBeVisible();
      if (browserName === "chromium" && !testInfo.project.ignoreSnapshots) {
        if (width === 1440)
          await expect(react.locator("#artifact-root > div")).toHaveScreenshot(
            ["conversations", "output-formats-desktop.png"],
            { animations: "disabled" },
          );
        else
          await expect(react.locator("#artifact-root > div")).toHaveScreenshot(
            ["conversations", "output-formats-mobile.png"],
            { animations: "disabled" },
          );
      }
      await expect(react.locator("#artifact-root > div")).toHaveCSS(
        "padding",
        "16px",
      );
      const saveImage = reactFrame
        .locator("..")
        .getByRole("button", { name: "Save image for export" });
      await saveImage.click();
      await expect(saveImage).toBeEnabled({ timeout: 25_000 });
      await expect(reactFrame.locator("..").getByRole("status")).toHaveText(
        "Image saved for HTML and PDF export.",
      );
      const exported = await page.request.get(
        `/api/v1/conversations/${conversation.id}/export?format=html`,
      );
      expect(exported.ok()).toBe(true);
      expect(await exported.text()).toContain('src="data:image/png;base64,');
      const notebooks = page.locator('iframe[title="Notebook output"]');
      await notebooks.nth(0).scrollIntoViewIfNeeded();
      await expect(
        notebooks
          .nth(0)
          .contentFrame()
          .getByRole("cell", { name: "42", exact: true }),
      ).toBeVisible();
      await notebooks.nth(1).scrollIntoViewIfNeeded();
      await expect(
        notebooks.nth(1).contentFrame().locator(".main-svg").first(),
      ).toBeVisible();
      await notebooks.nth(2).scrollIntoViewIfNeeded();
      await expect(
        notebooks.nth(2).contentFrame().locator("svg"),
      ).toBeVisible();
      await notebooks.nth(3).scrollIntoViewIfNeeded();
      await expect(
        notebooks.nth(3).contentFrame().locator("svg path").first(),
      ).toBeVisible();
      await notebooks.nth(4).scrollIntoViewIfNeeded();
      await expect(
        notebooks
          .nth(4)
          .contentFrame()
          .getByRole("meter", { name: "Threshold" }),
      ).toHaveAttribute("value", "4");
      const card = page.getByRole("region", { name: "Adaptive Card" });
      await card.scrollIntoViewIfNeeded();
      await expect(card.getByText("Saved card heading")).toBeVisible();
      await expect(card.getByText("Done", { exact: true })).toBeVisible();
      await expect(
        card.locator("table").getByText("Table value 42", { exact: true }),
      ).toBeVisible();
      await expect(
        card.getByRole("button", { name: "Submit to account" }),
      ).toBeDisabled();
      const app = page.locator('iframe[title="MCP app snapshot"]');
      await app.nth(0).scrollIntoViewIfNeeded();
      await expect(
        app.nth(0).contentFrame().locator("#saved-result"),
      ).toHaveText("Saved tool result");
      await app.nth(1).scrollIntoViewIfNeeded();
      // Exercise the real SDK transport without widening the imported source limit for its 660 KB bundle.
      await app
        .nth(1)
        .contentFrame()
        .locator("body")
        .evaluate((body, source) => {
          const script = document.createElement("script");
          script.textContent = source;
          body.append(script);
        }, sdk);
      await expect(app.nth(1).contentFrame().locator("#sdk-result")).toHaveText(
        "Actual MCP SDK saved result",
      );
      await app
        .nth(1)
        .contentFrame()
        .getByRole("button", { name: "Attempt host action" })
        .click();
      await expect(app.nth(1).contentFrame().getByRole("button")).toHaveText(
        "Host actions unavailable",
      );
      const scene = page.locator('iframe[title="Interactive 3D scene"]');
      await scene.scrollIntoViewIfNeeded();
      await expect(scene.contentFrame().locator("canvas")).toBeVisible();
      const saveScene = scene
        .locator("..")
        .getByRole("button", { name: "Save image for export" });
      await saveScene.click();
      await expect(saveScene).toBeEnabled({ timeout: 25_000 });
      await expect(scene.locator("..").getByRole("status")).toContainText(
        "Image saved",
      );
      const imageExport = await page.request.get(
        `/api/v1/conversations/${conversation.id}/export?format=html`,
      );
      const pixel = await page.evaluate(
        async (html) => {
          const root = new DOMParser().parseFromString(html, "text/html");
          const src = root.querySelectorAll<HTMLImageElement>(
            'img[alt="Saved visual output"]',
          )[1]?.src;
          if (!src) throw new Error("Saved Three image missing");
          const image = new Image();
          image.src = src;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        },
        await imageExport.text(),
      );
      expect(pixel).toEqual([255, 0, 0, 255]);
      await notebooks.nth(5).scrollIntoViewIfNeeded();
      await expect(
        notebooks.nth(5).contentFrame().locator("svg text"),
      ).toHaveText("43");
      await expect(
        page.locator('[role="alert"]').filter({ hasText: /\S/ }),
      ).toHaveCount(0);
    } finally {
      await page.request.delete(`/api/v1/conversations/${conversation.id}`);
    }
  });
}
