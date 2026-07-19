import { listTopics } from "@/lib/library/papers";
import type { CaptureResult } from "@/lib/capture";

/**
 * Self-contained HTML for the capture flow. These pages must work in any
 * logged-out browser (the Shortcut opens them on iPhone), so they are plain
 * server-rendered documents, not app pages behind the session gate.
 */

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STYLE = `
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 2rem 1.25rem;
         background: #f5f4f0; color: #1e2128; display: flex; justify-content: center; }
  main { max-width: 560px; width: 100%; }
  h1 { font-size: 1.3rem; margin: 0 0 0.25rem; }
  .card { background: #fff; border-radius: 14px; padding: 1.25rem; margin-top: 1rem;
          box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .meta { opacity: 0.7; font-size: 0.9rem; margin: 0.2rem 0 0.8rem; }
  .summary { font-size: 0.95rem; line-height: 1.5; }
  .error-details { font: 0.82rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: pre-wrap; overflow-wrap: anywhere; max-height: 55vh; overflow: auto;
          margin: 0; }
  label { display: block; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em;
          opacity: 0.6; margin: 1rem 0 0.3rem; }
  select, input[type=text] { width: 100%; padding: 0.6rem; font-size: 1rem; border-radius: 8px;
          border: 1px solid #ccc; background: #fff; box-sizing: border-box; }
  .tags { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.3rem; }
  .tag { border: 1px solid #ccc; border-radius: 999px; padding: 0.2rem 0.6rem; font-size: 0.8rem; }
  button { margin-top: 1.25rem; width: 100%; padding: 0.85rem; font-size: 1.05rem; font-weight: 600;
          border: 0; border-radius: 10px; background: #3f4fb0; color: #fff; min-height: 44px; }
  .error { color: #a42e2b; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · papernook</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function confirmationPage(result: CaptureResult, token: string): string {
  const { analysis, slug, proposedTopic } = result;
  const topics = new Set(listTopics());
  topics.add(proposedTopic);
  const options = [...topics]
    .sort()
    .map(
      (t) =>
        `<option value="${esc(t)}" ${t === proposedTopic ? "selected" : ""}>${esc(t)}${topics.has(t) && t === proposedTopic ? " (proposed)" : ""}</option>`,
    )
    .join("");
  const authors = analysis.authors.join(", ");
  const tags = analysis.tags
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join("");

  return page(
    "Confirm capture",
    `<h1>Captured ✓</h1>
<div class="card">
  <strong>${esc(analysis.title)}</strong>
  <p class="meta">${esc(authors)}${analysis.year ? ` · ${analysis.year}` : ""}${analysis.venue ? ` · ${esc(analysis.venue)}` : ""}</p>
  <p class="summary">${esc(analysis.summary)}</p>
  <div class="tags">${tags}</div>
  <form method="post" action="/add/confirm">
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="hidden" name="slug" value="${esc(slug)}">
    <label for="topic">Topic folder</label>
    <select id="topic" name="topic">${options}</select>
    <label for="newtopic">…or a new folder</label>
    <input type="text" id="newtopic" name="newtopic" placeholder="leave empty to use the selection">
    <button type="submit">Accept into library</button>
  </form>
</div>`,
  );
}

export function acceptedPage(slug: string, topic: string): string {
  return page(
    "Added",
    `<h1>Filed ✓</h1>
<div class="card">
  <p>The paper is now in <strong>${esc(topic)}</strong>. It will appear in PDF Expert over WebDAV, and its chat is ready in papernook.</p>
  <p><a href="/paper/${esc(topic)}/${esc(slug)}">Open it in papernook →</a></p>
</div>`,
  );
}

export function errorPage(message: string): string {
  return page(
    "Capture failed",
    `<h1 class="error">Capture failed</h1>
<div class="card"><pre class="error-details">${esc(message)}</pre></div>`,
  );
}
