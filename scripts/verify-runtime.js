/* Real bundled-runtime gate, run on the target OS before packaging. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const win = process.platform === 'win32';
const root = path.resolve(__dirname, '../resources/runtime');
const python = path.join(root, 'python', win ? 'python.exe' : 'bin/python3');
const tex = path.join(root, 'latex/bin', win ? 'windows' : process.platform === 'darwin' ? 'universal-darwin' : 'x86_64-linux');
const ffmpeg = path.join(root, 'ffmpeg');
const environment = { ...process.env, PATH: [ffmpeg, tex, process.env.PATH || ''].join(path.delimiter) };
for (const file of [python, path.join(tex, win ? 'latex.exe' : 'latex'), path.join(ffmpeg, win ? 'ffmpeg.exe' : 'ffmpeg')]) {
  fs.accessSync(file, win ? fs.constants.F_OK : fs.constants.X_OK);
}
// Exercise the bundled TeX binary directly: Manim suppresses its stdout on failure.
const diagnosticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manimlabs-tex-gate-'));
fs.writeFileSync(path.join(diagnosticDir, 'probe.tex'), String.raw`\documentclass{article}
\begin{document}Math runtime $x^2$\end{document}`);
execFileSync(path.join(tex, win ? 'latex.exe' : 'latex'), ['-interaction=nonstopmode', '-halt-on-error', 'probe.tex'], { cwd: diagnosticDir, env: environment, stdio: 'inherit', timeout: 120000 });
execFileSync(python, ['-c', 'import manim, numpy, cv2, pydub; print("Bundled imports verified")'], { env: environment, stdio: 'inherit' });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manimlabs-runtime-gate-'));
const scene = path.join(directory, 'scene.py');
fs.writeFileSync(scene, 'from manim import *\nclass RuntimeGate(Scene):\n    def construct(self):\n        self.play(Write(MathTex(r"\\frac{x^2}{\\sqrt{1+x}}")), run_time=0.5)\n        self.wait(0.5)\n');
execFileSync(python, ['-m', 'manim', '--renderer=cairo', '--disable_caching', '-ql', '--media_dir', path.join(directory, 'media'), scene, 'RuntimeGate'], { env: environment, stdio: 'inherit', timeout: 180000 });
const video = path.join(directory, 'media/videos/scene/480p15/RuntimeGate.mp4');
if (!fs.existsSync(video) || fs.statSync(video).size < 1000) throw new Error('Native MathTex render produced no usable video');
const probe = JSON.parse(execFileSync(path.join(ffmpeg, win ? 'ffprobe.exe' : 'ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], { env: environment, encoding: 'utf8' }));
if (!probe.streams.some(stream => stream.codec_type === 'video') || Math.abs(Number(probe.format.duration) - 1) > .15) throw new Error('Native video timing or video stream failed');
console.log('PASS bundled native MathTex/Write/FFmpeg render:', video);
