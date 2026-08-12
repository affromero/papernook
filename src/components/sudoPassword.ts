/**
 * One password prompt per page load for admin "sudo" actions. The password
 * only lives in this module's memory; callers clear it when the server
 * rejects it so the next action re-prompts.
 */

let cached: string | null = null;

export function promptSudoPassword(message: string): string | null {
  cached ??= window.prompt(message);
  return cached;
}

export function rejectSudoPassword(): void {
  cached = null;
}
