const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:/i;

function readBaseUrl(): string {
  const meta = import.meta as ImportMeta & { env?: { BASE_URL?: string } };
  return meta.env?.BASE_URL ?? '/';
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed || trimmed === '/') return '/';
  const core = trimmed.replace(/^\/+|\/+$/g, '');
  return `/${core}/`;
}

export function toPublicAssetUrl(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return normalizeBaseUrl(readBaseUrl());
  }

  if (ABSOLUTE_URL_PATTERN.test(trimmed) || trimmed.startsWith('//')) {
    return trimmed;
  }

  const baseUrl = normalizeBaseUrl(readBaseUrl());
  const relativePath = trimmed.replace(/^\/+/, '');
  return `${baseUrl}${relativePath}`;
}
