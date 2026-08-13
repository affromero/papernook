const GITHUB_HOST = "github.com";
const GITHUB_API = "https://api.github.com";
const FULL_SHA_RE = /^[a-f0-9]{40}$/i;
const MAX_URL_CHARS = 4_096;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SOURCE_LINES = 8_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface RepositorySourceIdentity {
  owner: string;
  repo: string;
  sha: string;
  path: string;
}

export interface VerifiedRepositorySource extends RepositorySourceIdentity {
  canonicalUrl: string;
  lines: string[];
}

interface ParsedGitHubBlob {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export class GitHubSourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 502 = 400,
  ) {
    super(message);
  }
}

function decodeSegment(segment: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new GitHubSourceError(`Invalid GitHub ${label}.`);
  }
  if (
    !decoded ||
    decoded === "." ||
    decoded === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(decoded)
  ) {
    throw new GitHubSourceError(`Invalid GitHub ${label}.`);
  }
  return decoded;
}

/** Parse the supported public GitHub file URL without making a request. */
export function parseGitHubBlobUrl(value: string): ParsedGitHubBlob {
  if (value.length > MAX_URL_CHARS) {
    throw new GitHubSourceError("GitHub URL is too long.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubSourceError("Invalid GitHub file URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== GITHUB_HOST ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new GitHubSourceError(
      "Repository analysis requires an https://github.com file URL.",
    );
  }
  const raw = url.pathname.split("/").filter(Boolean);
  if (raw.length < 5 || raw[2] !== "blob") {
    throw new GitHubSourceError(
      "Use a GitHub file URL in /owner/repository/blob/ref/path form.",
    );
  }
  const owner = decodeSegment(raw[0], "owner");
  const repo = decodeSegment(raw[1], "repository");
  const ref = decodeSegment(raw[3], "revision");
  const path = raw
    .slice(4)
    .map((segment) => decodeSegment(segment, "path"))
    .join("/");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner)) {
    throw new GitHubSourceError("Invalid GitHub owner.");
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new GitHubSourceError("Invalid GitHub repository.");
  }
  if (ref.length > 200 || path.length > 2_000) {
    throw new GitHubSourceError("GitHub revision or file path is too long.");
  }
  return { owner, repo, ref, path };
}

function githubBlobUrls(message: string): string[] {
  return [...message.matchAll(/https:\/\/github\.com\/[^\s<>"']+/gi)].map(
    ([match]) => match.replace(/[),.;!?]+$/, ""),
  );
}

/** Return the sole GitHub blob URL in a turn, rejecting ambiguous requests. */
export function githubBlobUrlFromMessage(message: string): string | null {
  const urls = githubBlobUrls(message);
  if (urls.length === 0) return null;
  if (urls.length > 1) {
    throw new GitHubSourceError(
      "Analyze one GitHub file per message so the source can be verified completely.",
    );
  }
  parseGitHubBlobUrl(urls[0]);
  return urls[0];
}

function requestHeaders(accept: string): HeadersInit {
  return {
    Accept: accept,
    "User-Agent": "papernook-source-verifier",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubFetch(url: string, accept: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: requestHeaders(accept),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GitHubSourceError("GitHub source verification timed out.", 502);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new GitHubSourceError(
      "GitHub redirected the source request; verification was refused.",
      502,
    );
  }
  if (!response.ok) {
    const unavailable =
      response.status === 404
        ? "GitHub repository, revision, or file was not found."
        : "GitHub source verification is temporarily unavailable.";
    throw new GitHubSourceError(unavailable, 502);
  }
  return response;
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
    throw new GitHubSourceError(
      "The GitHub file is too large for exhaustive analysis.",
      413,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new GitHubSourceError(
          "The GitHub file is too large for exhaustive analysis.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function resolveSha(source: ParsedGitHubBlob): Promise<string> {
  if (FULL_SHA_RE.test(source.ref)) return source.ref.toLowerCase();
  const endpoint = `${GITHUB_API}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits/${encodeURIComponent(source.ref)}`;
  const response = await githubFetch(endpoint, "application/vnd.github+json");
  let payload: unknown;
  try {
    const bytes = await boundedBytes(response);
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    if (error instanceof GitHubSourceError) throw error;
    throw new GitHubSourceError("GitHub returned an invalid revision.", 502);
  }
  const sha = (payload as { sha?: unknown })?.sha;
  if (typeof sha !== "string" || !FULL_SHA_RE.test(sha)) {
    throw new GitHubSourceError("GitHub returned an invalid revision.", 502);
  }
  return sha.toLowerCase();
}

function canonicalUrl(source: RepositorySourceIdentity): string {
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/blob/${source.sha}/${path}`;
}

/** Resolve a branch/tag once, then fetch the complete public file by SHA. */
export async function fetchVerifiedGitHubSource(
  input: string | RepositorySourceIdentity,
): Promise<VerifiedRepositorySource> {
  if (typeof input !== "string" && !FULL_SHA_RE.test(input.sha)) {
    throw new GitHubSourceError("Invalid pinned GitHub revision.");
  }
  const parsed =
    typeof input === "string"
      ? parseGitHubBlobUrl(input)
      : parseGitHubBlobUrl(canonicalUrl(input));
  const sha = await resolveSha(parsed);
  const encodedPath = parsed.path.split("/").map(encodeURIComponent).join("/");
  const endpoint = `${GITHUB_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents/${encodedPath}?ref=${sha}`;
  const response = await githubFetch(
    endpoint,
    "application/vnd.github.raw+json",
  );
  const bytes = await boundedBytes(response);
  if (bytes.includes(0)) {
    throw new GitHubSourceError(
      "The GitHub file is binary and cannot be analyzed as source.",
      400,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubSourceError(
      "The GitHub file is not valid UTF-8 source text.",
      400,
    );
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (lines.length > MAX_SOURCE_LINES) {
    throw new GitHubSourceError(
      "The GitHub file has too many lines for exhaustive analysis.",
      413,
    );
  }
  const identity = {
    owner: parsed.owner,
    repo: parsed.repo,
    sha,
    path: parsed.path,
  };
  return { ...identity, canonicalUrl: canonicalUrl(identity), lines };
}
