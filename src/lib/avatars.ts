/**
 * Preset profile avatars: cute animals from the Colombian tropics, shared with
 * Sotto. Each has an illustration at /avatars/{slug}.png shipped in
 * public/avatars. The profile picker, header menu, and settings grid all draw
 * from these via resolveProfileAvatar(). The emoji + hue remain an offline
 * fallback tile.
 */

export interface AnimalAvatar {
  slug: string;
  name: string;
  /** Fallback glyph shown until the generated image exists. */
  emoji: string;
  /** Accent for the fallback tile gradient. */
  hue: string;
}

export const ANIMAL_AVATARS: AnimalAvatar[] = [
  { slug: 'capybara', name: 'Capybara', emoji: '🦫', hue: '#3F4FB0' },
  { slug: 'iguana', name: 'Iguana', emoji: '🦎', hue: '#0D9488' },
  { slug: 'sloth', name: 'Sloth', emoji: '🦥', hue: '#8A6D3B' },
  { slug: 'toucan', name: 'Toucan', emoji: '🐦', hue: '#B83280' },
  { slug: 'macaw', name: 'Macaw', emoji: '🦜', hue: '#C2730A' },
  { slug: 'frog', name: 'Poison frog', emoji: '🐸', hue: '#1C7A6B' },
  { slug: 'hummingbird', name: 'Hummingbird', emoji: '🐤', hue: '#6AA0FF' },
  { slug: 'jaguar', name: 'Jaguar', emoji: '🐆', hue: '#2A3550' },
];

const BY_SLUG = new Map(ANIMAL_AVATARS.map((a) => [a.slug, a]));

/** The image path for an avatar slug, or null for an unknown image. */
export function avatarImagePath(slug: string): string | null {
  return BY_SLUG.has(slug) ? `/avatars/${slug}.png` : null;
}

export function isAnimalSlug(value: string): boolean {
  return BY_SLUG.has(value);
}

export function getAnimalAvatar(slug: string): AnimalAvatar | undefined {
  return BY_SLUG.get(slug);
}

/**
 * A stable animal avatar for a seed string (typically a username), so every
 * profile shows a distinct animal even when none was chosen. Deterministic.
 */
export function animalForSeed(seed: string): AnimalAvatar {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return ANIMAL_AVATARS[hash % ANIMAL_AVATARS.length];
}

/**
 * Resolve a profile's display avatar to one of the animals. Keeps an
 * explicitly chosen animal image; anything else falls back to a deterministic
 * animal for the seed. Always returns a local `/avatars/*.png` path.
 */
export function resolveProfileAvatar(
  seed: string,
  image: string | null | undefined
): { image: string; emoji: string } {
  if (image && image.startsWith('/avatars/')) {
    const slug = image.slice('/avatars/'.length).replace(/\.png$/, '');
    const known = getAnimalAvatar(slug);
    if (known) return { image: `/avatars/${known.slug}.png`, emoji: known.emoji };
  }
  const animal = animalForSeed(seed);
  return { image: `/avatars/${animal.slug}.png`, emoji: animal.emoji };
}
