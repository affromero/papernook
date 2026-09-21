import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";

interface StoredSession {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
}

/** Reuse the fixture member session for journeys unrelated to authentication. */
export async function restoreMayaSession(page: Page): Promise<void> {
  const stored = JSON.parse(
    await readFile(
      path.join(process.cwd(), ".playwright-data", ".maya-storage-state.json"),
      "utf8",
    ),
  ) as StoredSession;
  await page.context().addCookies(stored.cookies);
  await page.goto("/");
}
