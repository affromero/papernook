export function previewIdentity(kind: string, source: string): string {
  return JSON.stringify(["papernook-preview-v1", kind, source]);
}
