const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:/i;
function readBaseUrl() {
    const meta = import.meta;
    return meta.env?.BASE_URL ?? '/';
}
function normalizeBaseUrl(baseUrl) {
    const trimmed = baseUrl.trim();
    if (!trimmed || trimmed === '/')
        return '/';
    const core = trimmed.replace(/^\/+|\/+$/g, '');
    return `/${core}/`;
}
export function toPublicAssetUrl(pathValue) {
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
