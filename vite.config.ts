import { createSongImportApiPlugin } from './src/server/songImportApi';

function normalizeBasePath(rawBasePath: string): string {
  const trimmed = rawBasePath.trim();
  if (!trimmed || trimmed === '/') return '/';
  const core = trimmed.replace(/^\/+|\/+$/g, '');
  return `/${core}/`;
}

function resolveBasePath(): string {
  const explicitBasePath = process.env.VITE_BASE_PATH;
  if (explicitBasePath) {
    return normalizeBasePath(explicitBasePath);
  }

  const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
  const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1];
  if (isGitHubActions && repositoryName) {
    return normalizeBasePath(repositoryName);
  }

  return '/';
}

export default {
  base: resolveBasePath(),
  plugins: [createSongImportApiPlugin()],
  server: { host: '0.0.0.0', port: 5173 }
};
