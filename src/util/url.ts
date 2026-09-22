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
