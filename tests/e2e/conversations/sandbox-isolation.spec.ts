import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";

const source =
  "document.body.dataset.userExecuted = 'yes'; document.body.dataset.exposed = localStorage.getItem('sandbox-private-fixture');";
const previews = [
  {
    name: "HTML artifact",
    url: `/vendor/conversations/sandbox.html#${encodeURIComponent(JSON.stringify({ kind: "html-preview", source: `<script>${source}</script>` }))}`,
  },
  {
    name: "React artifact",
    url: `/vendor/conversations/sandbox.html#${encodeURIComponent(JSON.stringify({ kind: "react-preview", source: `${source}\nexport default function App(){return null;}` }))}`,
  },
  {
    name: "Three.js scene",
    url: `/vendor/three-sandbox.html#${encodeURIComponent(source)}`,
  },
];

for (const preview of previews) {
  test(`${preview.name} rejects direct navigation before executing imported code`, async ({
    page,
  }) => {
    await restoreMayaSession(page);
    await page.evaluate(() =>
      localStorage.setItem(
        "sandbox-private-fixture",
        "private offline fixture",
      ),
    );
    await page.goto(preview.url);
    await expect(
      page.getByText(/Open this (preview|scene) inside the isolated/),
    ).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute(
      "data-user-executed",
    );
    await expect(page.locator("body")).not.toHaveAttribute("data-exposed");
  });

  for (const sandbox of [null, "allow-scripts allow-same-origin"]) {
    test(`${preview.name} rejects ${sandbox ? "a frame with same-origin access" : "an unsandboxed frame"}`, async ({
      page,
    }) => {
      await restoreMayaSession(page);
      await page.evaluate(
        ({ url, sandbox }) => {
          localStorage.setItem(
            "sandbox-private-fixture",
            "private offline fixture",
          );
          const frame = document.createElement("iframe");
          frame.id = "preview-isolation-fixture";
          frame.src = url;
          if (sandbox) frame.setAttribute("sandbox", sandbox);
          document.body.append(frame);
        },
        { url: preview.url, sandbox },
      );
      const frame = page.frameLocator("#preview-isolation-fixture");
      await expect(
        frame.getByText(/Open this (preview|scene) inside the isolated/),
      ).toBeVisible();
      await expect(frame.locator("body")).not.toHaveAttribute(
        "data-user-executed",
      );
      await expect(frame.locator("body")).not.toHaveAttribute("data-exposed");
    });
  }
}

test("React artifacts execute only inside their frame and cannot read private parent state or use the network", async ({
  page,
}) => {
  await restoreMayaSession(page);
  await page.evaluate(() =>
    localStorage.setItem("sandbox-private-fixture", "private offline fixture"),
  );
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
                content: `import React from "react";
let parentState; try { parent.document.body; parentState="Parent accessible"; } catch { parentState="Parent isolated"; }
let storageState; try { localStorage.getItem("sandbox-private-fixture"); storageState="Storage accessible"; } catch { storageState="Storage isolated"; }
export default function App(){ const [network,setNetwork]=React.useState("Checking network"); React.useEffect(()=>{fetch("https://example.com/artifact-exfiltration").then(()=>setNetwork("Network accessible")).catch(()=>setNetwork("Network blocked"));},[]); return <><p>{parentState}</p><p>{storageState}</p><p>{network}</p></>; }`,
              },
            ],
          },
        ],
      }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversation } = await response.json();
  const outside: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.com/"))
      outside.push(request.url());
  });
  try {
    await page.goto(`/conversations/${conversation.id}`);
    const iframe = page.locator('iframe[title="React artifact"]');
    await iframe.scrollIntoViewIfNeeded();
    const artifact = iframe.contentFrame();
    await expect(
      artifact.getByText("Parent isolated", { exact: true }),
    ).toBeVisible();
    await expect(
      artifact.getByText("Storage isolated", { exact: true }),
    ).toBeVisible();
    await expect(
      artifact.getByText("Network blocked", { exact: true }),
    ).toBeVisible();
    expect(outside).toEqual([]);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("sandbox-private-fixture"),
      ),
    ).toBe("private offline fixture");
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});

test("HTML event handlers keep closing-script text literal without creating elements or network requests", async ({
  page,
}) => {
  await restoreMayaSession(page);
  const literal = "</script><img src=https://example.com/literal>";
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
                mime_type: "text/html",
                content:
                  "<button onclick=\"this.textContent='&lt;/script&gt;&lt;img src=https://example.com/literal&gt;'\">Show literal</button>",
              },
            ],
          },
        ],
      }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversation } = await response.json();
  const outside: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.com/"))
      outside.push(request.url());
  });
  try {
    await page.goto(`/conversations/${conversation.id}`);
    const iframe = page.locator('iframe[title="HTML artifact"]');
    await iframe.scrollIntoViewIfNeeded();
    const artifact = iframe.contentFrame();
    await artifact.getByRole("button", { name: "Show literal" }).click();
    await expect(artifact.getByRole("button")).toHaveText(literal);
    await expect(artifact.locator("img")).toHaveCount(0);
    expect(outside).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});
