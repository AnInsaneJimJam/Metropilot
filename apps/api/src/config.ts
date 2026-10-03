// Process configuration from the environment. Values are secrets by default: errors name the
// variable, never its value, and URLs are only ever printed through redactUrl().

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type Env = Readonly<Record<string, string | undefined>>;

export function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new ConfigError(`${name} is not set; copy .env.example to .env`);
  return value;
}

export function databaseUrl(env: Env): URL {
  let url: URL;
  try {
    url = new URL(requireEnv(env, 'DATABASE_URL'));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConfigError('DATABASE_URL must use the postgres:// scheme');
  }
  return url;
}

export const isLoopback = (url: URL): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

export function redactUrl(url: URL): string {
  const copy = new URL(url);
  if (copy.password) copy.password = '***';
  return copy.toString();
}
