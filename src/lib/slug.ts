/**
 * Slugs name both the PDF and its companion folder:
 * data/papers/<topic>/<slug>.pdf ↔ data/library/<topic>/<slug>/.
 * Topic folders use the same rules.
 */

const MAX_SLUG = 80;

export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug;
}

export function isValidSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

/** A slug that is safe as a path segment (never traverses). */
export function assertSlug(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) {
    throw new Error(`Invalid slug: ${JSON.stringify(value)}`);
  }
  return value;
}
