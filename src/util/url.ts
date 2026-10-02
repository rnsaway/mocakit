/** Strips credentials, query and hash from a URL, for safe inclusion in error messages/logs. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '<invalid URL>';
  }
}

/** REST base for a MOCA service URL: `https://h/x/service` → `https://h/x/`. */
export function apiBaseUrl(serviceUrl: string): string {
  const url = new URL(serviceUrl);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/service\/?$/, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}
