/* IP allow-list shared by the chart editor, the test-bed songs and the scores API.
 *
 * EDITOR_ALLOWED_IPS="1.2.3.4, 5.6.7., 2001:db8::1"
 *   - exact IPv4/IPv6 address, or
 *   - a prefix ending with "." (IPv4) or ":" (IPv6) to allow a whole range.
 * Outside production (next dev) everything is allowed when the variable is unset.
 */

export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return headers.get("x-real-ip")?.trim() || headers.get("x-vercel-forwarded-for")?.trim() || "";
}

function normalize(ip: string): string {
  const v = ip.trim().toLowerCase();
  return v.startsWith("::ffff:") ? v.slice(7) : v; // IPv4-mapped IPv6
}

/** Allow-list entries: split on commas, semicolons, spaces and newlines; quotes are ignored. */
export function allowList(): string[] {
  const raw = process.env.EDITOR_ALLOWED_IPS ?? "";
  return raw
    .split(/[\s,;]+/)
    .map((e) => normalize(e.replace(/["']/g, "")))
    .filter(Boolean);
}

export function isAllowedIp(ip: string): boolean {
  const list = allowList();
  const me = normalize(ip);
  if (list.length === 0) return process.env.NODE_ENV !== "production";
  if (!me) return false;
  return list.some((entry) => (entry.endsWith(".") || entry.endsWith(":") ? me.startsWith(entry) : me === entry));
}

export function isPrivileged(headers: Headers): boolean {
  return isAllowedIp(clientIp(headers));
}
