/**
 * Convert a Windows drive-letter path to a WSL2 /mnt/ path.
 * Paths that are already POSIX (start with /) are returned unchanged.
 *
 * E:\foo\bar  → /mnt/e/foo/bar
 * E:/foo/bar  → /mnt/e/foo/bar
 * /home/avion → /home/avion  (unchanged)
 */
export function toWslPath(p: string): string {
  const m = p.match(/^([A-Za-z]):[/\\](.*)/);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}
