const TRUSTED_ORIGINS = new Set([
  "https://www.manimlabs.com", "https://manimlabs.com", "https://manim-std.vercel.app",
]);

/** Browser origin is the boundary before accepting locally executable scenes. */
export function isTrustedAgentOrigin(value: string | undefined, packaged: boolean): boolean {
  if (!value) return false;
  try {
    const origin = new URL(value);
    if (origin.origin !== value || origin.username || origin.password) return false;
    if (TRUSTED_ORIGINS.has(value)) return true;
    return !packaged && ["http:", "https:"].includes(origin.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  } catch { return false; }
}
