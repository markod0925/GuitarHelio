const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:/i;

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed || trimmed === '/') return '/';
  const core = trimmed.replace(/^\/+|\/+$/g, '');
  return `/${core}/`;
}

export function toPublicAssetUrl(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return normalizeBaseUrl(import.meta.env.BASE_URL ?? '/');
  }

  if (ABSOLUTE_URL_PATTERN.test(trimmed) || trimmed.startsWith('//')) {
    return trimmed;
  }

  const baseUrl = normalizeBaseUrl(import.meta.env.BASE_URL ?? '/');
  const relativePath = trimmed.replace(/^\/+/, '');
  return `${baseUrl}${relativePath}`;
}
