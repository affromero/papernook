import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./data-dir";
import { withFilesystemLock } from "./filesystem-lock";

const GITHUB_HOST = "github.com";
const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const FULL_SHA_RE = /^[a-f0-9]{40}$/i;
const MAX_URL_CHARS = 4_096;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const MAX_REPOSITORY_BYTES = 768 * 1024;
const MAX_FILE_BYTES = 192 * 1024;
const MAX_REPOSITORY_FILES = 250;
const MAX_REPOSITORY_LINES = 30_000;
const RAW_FETCH_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_POLICY_VERSION = 1;

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cfg",
  ".cmake",
  ".cpp",
  ".css",
  ".cu",
  ".cuh",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".m",
  ".md",
  ".metal",
  ".mm",
  ".php",
  ".proto",
  ".py",
  ".pyi",
  ".r",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);
const SOURCE_FILENAMES = new Set([
  ".gitmodules",
  "cmakelists.txt",
  "containerfile",
  "dockerfile",
  "gemfile",
  "makefile",
  "procfile",
  "requirements.txt",
]);
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".venv",
  "__pycache__",
  "assets",
  "build",
  "checkpoints",
  "coverage",
  "data",
  "datasets",
  "dist",
  "node_modules",
  "outputs",
  "third_party",
  "vendor",
]);

export interface RepositorySourceIdentity {
  owner: string;
  repo: string;
  sha: string;
  /** The linked file that anchors repository traversal. */
  path: string;
}

export interface VerifiedRepositoryFile {
  path: string;
  lines: string[];
}

export interface VerifiedRepositorySource extends RepositorySourceIdentity {
  canonicalUrl: string;
  files: VerifiedRepositoryFile[];
  complete: boolean;
  omittedFileCount: number;
  omittedPaths: string[];
}

interface ParsedGitHubBlob {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

interface GitTreeEntry {
  path: string;
  type: "blob";
  size: number;
}

interface RepositoryTree {
  blobs: GitTreeEntry[];
  gitlinks: string[];
}

export class GitHubSourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 429 | 502 = 400,
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
  const sourcePath = raw
    .slice(4)
    .map((segment) => decodeSegment(segment, "path"))
    .join("/");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner)) {
    throw new GitHubSourceError("Invalid GitHub owner.");
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new GitHubSourceError("Invalid GitHub repository.");
  }
  if (ref.length > 200 || sourcePath.length > 2_000) {
    throw new GitHubSourceError("GitHub revision or file path is too long.");
  }
  return { owner, repo, ref, path: sourcePath };
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
      "Analyze one GitHub repository per message so it can be pinned and verified completely.",
    );
  }
  parseGitHubBlobUrl(urls[0]);
  return urls[0];
}

function requestHeaders(url: string, accept: string): HeadersInit {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "papernook-source-verifier",
  };
  if (url.startsWith(GITHUB_API)) {
    headers["X-GitHub-Api-Version"] = "2022-11-28";
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
  }
  return headers;
}

async function githubFetch(url: string, accept: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: requestHeaders(url, accept),
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
    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get("x-ratelimit-remaining") === "0"
    ) {
      throw new GitHubSourceError(
        "GitHub repository analysis is rate-limited. Configure GITHUB_TOKEN or try again later.",
        429,
      );
    }
    const unavailable =
      response.status === 404
        ? "GitHub repository, revision, or file was not found."
        : "GitHub source verification is temporarily unavailable.";
    throw new GitHubSourceError(unavailable, 502);
  }
  return response;
}

async function boundedBytes(
  response: Response,
  maximum: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new GitHubSourceError(tooLargeMessage, 413);
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
      if (total > maximum) {
        await reader.cancel();
        throw new GitHubSourceError(tooLargeMessage, 413);
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

async function jsonResponse(
  response: Response,
  maximum: number,
  tooLargeMessage: string,
): Promise<unknown> {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedBytes(response, maximum, tooLargeMessage),
      ),
    ) as unknown;
  } catch (error) {
    if (error instanceof GitHubSourceError) throw error;
    throw new GitHubSourceError(
      "GitHub returned invalid repository data.",
      502,
    );
  }
}

async function resolveSha(source: ParsedGitHubBlob): Promise<string> {
  if (FULL_SHA_RE.test(source.ref)) return source.ref.toLowerCase();
  const endpoint = `${GITHUB_API}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits/${encodeURIComponent(source.ref)}`;
  const payload = await jsonResponse(
    await githubFetch(endpoint, "application/vnd.github+json"),
    MAX_FILE_BYTES,
    "The GitHub revision response is too large.",
  );
  const sha = (payload as { sha?: unknown })?.sha;
  if (typeof sha !== "string" || !FULL_SHA_RE.test(sha)) {
    throw new GitHubSourceError("GitHub returned an invalid revision.", 502);
  }
  return sha.toLowerCase();
}

function canonicalUrl(
  source: RepositorySourceIdentity,
  file = source.path,
): string {
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/blob/${source.sha}/${encodedPath}`;
}

function safeTreePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2_000 &&
    !value.startsWith("/") &&
    !/[\\\u0000-\u001f\u007f]/.test(value) &&
    value
      .split("/")
      .every((segment) => segment && segment !== "." && segment !== "..")
  );
}

function eligibleSourcePath(sourcePath: string): boolean {
  const segments = sourcePath.toLowerCase().split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  const filename = segments.at(-1) ?? "";
  if (
    filename.endsWith(".lock") ||
    filename.endsWith(".min.js") ||
    filename.endsWith(".map")
  ) {
    return false;
  }
  return (
    SOURCE_FILENAMES.has(filename) ||
    SOURCE_EXTENSIONS.has(path.extname(filename))
  );
}

function sourcePriority(entrypoint: string, candidate: string): number {
  if (candidate === entrypoint) return 0;
  const filename = path.posix.basename(candidate).toLowerCase();
  if (filename.startsWith("readme") || filename === "pyproject.toml") return 1;
  if (SOURCE_FILENAMES.has(filename)) return 2;
  if (
    [".json", ".toml", ".yaml", ".yml", ".ini", ".cfg"].includes(
      path.extname(filename),
    )
  ) {
    return 3;
  }
  return 4;
}

async function repositoryTree(
  source: RepositorySourceIdentity,
): Promise<RepositoryTree> {
  const endpoint = `${GITHUB_API}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${source.sha}?recursive=1`;
  const payload = await jsonResponse(
    await githubFetch(endpoint, "application/vnd.github+json"),
    MAX_TREE_BYTES,
    "The GitHub repository tree is too large to verify safely.",
  );
  const record = payload as { tree?: unknown; truncated?: unknown };
  if (record.truncated === true) {
    throw new GitHubSourceError(
      "GitHub truncated the repository tree, so exhaustive analysis is unavailable.",
      413,
    );
  }
  if (!Array.isArray(record.tree)) {
    throw new GitHubSourceError(
      "GitHub returned an invalid repository tree.",
      502,
    );
  }
  const entries: GitTreeEntry[] = [];
  const gitlinks: string[] = [];
  for (const raw of record.tree) {
    const entry = raw as { path?: unknown; type?: unknown; size?: unknown };
    if (typeof entry.path !== "string" || !safeTreePath(entry.path)) {
      throw new GitHubSourceError(
        "GitHub returned an unsafe repository path.",
        502,
      );
    }
    if (entry.type === "commit") {
      gitlinks.push(entry.path);
      continue;
    }
    if (entry.type !== "blob") continue;
    if (
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new GitHubSourceError(
        "GitHub returned invalid repository file metadata.",
        502,
      );
    }
    entries.push({ path: entry.path, type: "blob", size: entry.size });
  }
  return { blobs: entries, gitlinks };
}

async function fetchRepositoryFile(
  source: RepositorySourceIdentity,
  sourcePath: string,
): Promise<VerifiedRepositoryFile | null> {
  const encodedPath = sourcePath.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_RAW}/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${source.sha}/${encodedPath}`;
  const response = await githubFetch(url, "text/plain");
  const bytes = await boundedBytes(
    response,
    MAX_FILE_BYTES,
    `Repository file ${sourcePath} is too large to analyze safely.`,
  );
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return { path: sourcePath, lines };
}

async function mapConcurrent<T, R>(
  values: T[],
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(RAW_FETCH_CONCURRENCY, values.length) },
      async () => {
        while (cursor < values.length) {
          const index = cursor++;
          results[index] = await mapper(values[index]);
        }
      },
    ),
  );
  return results;
}

function cacheFile(source: RepositorySourceIdentity): string {
  const digest = crypto
    .createHash("sha256")
    .update(
      `${CACHE_POLICY_VERSION}\0${source.owner}\0${source.repo}\0${source.sha}\0${source.path}`,
    )
    .digest("hex");
  return path.join(dataRoot(), "repository-cache", `${digest}.json`);
}

function readCache(
  source: RepositorySourceIdentity,
): VerifiedRepositorySource | null {
  try {
    const cached = JSON.parse(
      fs.readFileSync(cacheFile(source), "utf8"),
    ) as VerifiedRepositorySource;
    if (
      cached.owner !== source.owner ||
      cached.repo !== source.repo ||
      cached.sha !== source.sha ||
      cached.path !== source.path ||
      cached.canonicalUrl !== canonicalUrl(source) ||
      typeof cached.complete !== "boolean" ||
      !Number.isSafeInteger(cached.omittedFileCount) ||
      cached.omittedFileCount < 0 ||
      !Array.isArray(cached.omittedPaths) ||
      !cached.omittedPaths.every((omitted) => typeof omitted === "string") ||
      !Array.isArray(cached.files) ||
      !cached.files.every(
        (file) =>
          typeof file?.path === "string" &&
          safeTreePath(file.path) &&
          Array.isArray(file.lines) &&
          file.lines.every((line) => typeof line === "string"),
      )
    ) {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

function writeCache(source: VerifiedRepositorySource): void {
  const file = cacheFile(source);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(source), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

async function buildRepositorySnapshot(
  source: RepositorySourceIdentity,
): Promise<VerifiedRepositorySource> {
  const tree = await repositoryTree(source);
  const entrypoint = tree.blobs.find((entry) => entry.path === source.path);
  if (!entrypoint) {
    throw new GitHubSourceError(
      "GitHub repository, revision, or file was not found.",
      502,
    );
  }
  if (!eligibleSourcePath(source.path) || entrypoint.size > MAX_FILE_BYTES) {
    throw new GitHubSourceError(
      "The linked GitHub file cannot be analyzed as source.",
      413,
    );
  }

  const eligible = tree.blobs
    .filter((entry) => eligibleSourcePath(entry.path))
    .sort(
      (left, right) =>
        sourcePriority(source.path, left.path) -
          sourcePriority(source.path, right.path) ||
        left.path.localeCompare(right.path),
    );
  const selected: GitTreeEntry[] = [];
  const omittedPaths: string[] = tree.gitlinks.map(
    (gitlink) => `${gitlink} (pinned submodule contents are external)`,
  );
  let selectedBytes = 0;
  for (const entry of eligible) {
    if (
      entry.size > MAX_FILE_BYTES ||
      selected.length >= MAX_REPOSITORY_FILES ||
      selectedBytes + entry.size > MAX_REPOSITORY_BYTES
    ) {
      omittedPaths.push(entry.path);
      continue;
    }
    selected.push(entry);
    selectedBytes += entry.size;
  }
  const fetched = await mapConcurrent(selected, (entry) =>
    fetchRepositoryFile(source, entry.path),
  );
  const files: VerifiedRepositoryFile[] = [];
  let totalLines = 0;
  for (let index = 0; index < fetched.length; index += 1) {
    const file = fetched[index];
    if (!file || totalLines + file.lines.length > MAX_REPOSITORY_LINES) {
      omittedPaths.push(selected[index].path);
      continue;
    }
    files.push(file);
    totalLines += file.lines.length;
  }
  if (files[0]?.path !== source.path) {
    throw new GitHubSourceError(
      "The linked GitHub file is not valid UTF-8 source text.",
      400,
    );
  }
  return {
    ...source,
    canonicalUrl: canonicalUrl(source),
    files,
    complete: omittedPaths.length === 0,
    omittedFileCount: omittedPaths.length,
    omittedPaths,
  };
}

/** Resolve a revision once, then fetch and cache a bounded pinned repository. */
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
  const source: RepositorySourceIdentity = {
    owner: parsed.owner,
    repo: parsed.repo,
    sha: await resolveSha(parsed),
    path: parsed.path,
  };
  return withFilesystemLock(
    "repository-source",
    JSON.stringify([CACHE_POLICY_VERSION, source]),
    120_000,
    async () => {
      const cached = readCache(source);
      if (cached) return cached;
      const snapshot = await buildRepositorySnapshot(source);
      writeCache(snapshot);
      return snapshot;
    },
  );
}
