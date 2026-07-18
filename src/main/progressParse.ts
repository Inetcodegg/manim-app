/**
 * Manim's own stdout/stderr progress parsing — ported line-for-line from
 * the website's cloud render worker (src/lib/server/renderQueue.ts) so a
 * local render reports progress with the exact same feel (0.97 cap during
 * rendering, 0.98 bump on the mux line, monotonic never-decreasing) as the
 * cloud path the site's UI was built against. Kept as its own module so a
 * future protocol/UI change can't accidentally diverge the two.
 */

export function countTotalAnimations(code: string): number {
  const playCount = (code.match(/self\.play\(/g) ?? []).length;
  const cameraCount = (code.match(/self\.move_camera\(/g) ?? []).length;
  const waitCount = (code.match(/self\.wait\(/g) ?? []).length;
  return Math.max(1, playCount + cameraCount + waitCount);
}

export interface ProgressState {
  animsDone: number;
  lastProgress: number;
  muxing: boolean;
}

export function freshProgressState(): ProgressState {
  return { animsDone: 0, lastProgress: 0, muxing: false };
}

/** Feed one chunk of combined stdout+stderr text; returns the updated,
 *  monotonic 0..1 progress value. */
export function progressFromChunk(state: ProgressState, chunk: string, totalAnims: number): number {
  if (/Rendered .* Played \d+ animations/i.test(chunk)) {
    state.muxing = true;
  }
  const animMatches = [...chunk.matchAll(/Animation (\d+)/g)];
  if (animMatches.length) {
    const last = animMatches[animMatches.length - 1];
    state.animsDone = Math.max(state.animsDone, Number(last[1]));
  }
  const pctMatches = [...chunk.matchAll(/(\d+)%\|/g)];
  const innerPct = pctMatches.length ? Number(pctMatches[pctMatches.length - 1][1]) : 0;

  let progress = (state.animsDone + innerPct / 100) / totalAnims;
  progress = Math.min(state.muxing ? 0.98 : 0.97, progress);
  state.lastProgress = Math.max(state.lastProgress, progress);
  return state.lastProgress;
}

/** Manim redraws its tqdm bar in place with bare `\r` — keep only the
 *  final redrawn state of each line, and cap total retained lines so a
 *  long render doesn't grow the in-memory log without bound. */
export function extractLogLines(existing: string[], chunk: string): string[] {
  const parts = chunk.split(/\r\n|\r|\n/);
  const lines = [...existing];
  for (const part of parts) {
    if (part === "") continue;
    lines.push(part);
  }
  return lines.slice(-500);
}

const KNOWN_ISSUES: { pattern: RegExp; hint: string }[] = [
  { pattern: /\.sty['")\s]/i, hint: "A LaTeX package (.sty file) is missing. Try re-running setup to reinstall LaTeX packages." },
  { pattern: /\.def['")\s]/i, hint: "A LaTeX definition file (.def) is missing. Try re-running setup to reinstall LaTeX packages." },
  { pattern: /\.cls['")\s]/i, hint: "A LaTeX document class (.cls file) is missing. Try re-running setup to reinstall LaTeX packages." },
  { pattern: /latex error/i, hint: "LaTeX failed to compile a formula or text object. Check the formula's syntax." },
  { pattern: /(command not found|is not recognized).*latex/i, hint: "LaTeX isn't installed correctly. Try Repair setup from the tray menu." },
  { pattern: /(command not found|is not recognized).*ffmpeg/i, hint: "FFmpeg isn't installed correctly. Try Repair setup from the tray menu." },
  { pattern: /(command not found|is not recognized).*manim/i, hint: "Manim isn't installed correctly. Try Repair setup from the tray menu." },
  { pattern: /ModuleNotFoundError/i, hint: "A required Python package is missing. Try Repair setup from the tray menu." },
];

export function diagnose(logs: string[]): string | null {
  const tail = logs.slice(-80).join("\n");
  for (const { pattern, hint } of KNOWN_ISSUES) {
    if (pattern.test(tail)) return hint;
  }
  return null;
}
