# Manim Studio Render Agent

A Windows desktop companion for [Manim Studio](https://manim-std.vercel.app):
it runs Manim **on the user's own machine** — with Python, Manim, LaTeX, and
FFmpeg all bundled inside the installer — and connects to the website over an
encrypted local WebSocket so the browser can send it a compiled scene and get
back render progress and a finished video, without touching any cloud render
queue. It also signs in with the same Manim Studio account as the website,
shows admin-published notifications, and can update itself.

## What "bundled" means here

The end user downloads **one installer** and runs it. That's the entire
setup experience — no first-run download, no "installing Python…" wait, no
internet access required after that point to start rendering. Every runtime
dependency is already inside the installer:

- **Python 3.12** (the official embeddable distribution) with **Manim
  0.19.x** and **numpy** already `pip install`-ed into it.
- **TinyTeX** (a minimal, self-contained TeX Live) with the same LaTeX
  package set the cloud renderer uses, already provisioned.
- **FFmpeg** (static Windows build), for muxing.

All of this is assembled once, on a *developer's* machine, by
`npm run prepare-runtime` (see `scripts/prepare-runtime.js`) into
`resources/runtime/` — which `electron-builder`'s `extraResources` config
then copies verbatim into the installer. The user's machine never runs that
script; it only ever runs the finished app, which just calls the already-
installed binaries directly. See `src/main/paths.ts` for exactly where each
piece lives once installed.

This deliberately mirrors the cloud render server's own versions (Python
3.12, `manim==0.19.*`, the same LaTeX package list, FFmpeg) — see
`scripts/prepare-runtime.js`'s comments — so a scene renders identically
whether it goes through the cloud queue or this local agent.

## How it fits together

```
 Browser tab (manim-std.vercel.app)
        │  compiles the project into SEGMENTS at safe cut points,
        │  hashes each one (src/lib/compiler/segments.ts, site repo)
        │  WebSocket  wss://127.0.0.1:61247  (TLS — self-signed cert, see tls.ts)
        ▼
 AgentServer (src/main/wsServer.ts)
        │  for each segment: cache hit? reuse the clip. cache miss? render it.
        ▼
 python.exe -m manim render scene.py <SceneClass>   (src/main/renderWorker.ts, per segment)
        │  progress parsed from stdout/stderr
        ▼
 per-segment clips → ffmpeg concat (lossless stream copy) → final video
        │  registered in the local render library (src/main/renderLibrary.ts)
        │  served over
        ▼
 https://127.0.0.1:61248/video/<id>                   (src/main/videoServer.ts)
        │
        ▼
 <video src="..."> back in the same browser tab
```

The agent never compiles a `Project` to Python itself — the website already
has that compiler (`src/lib/compiler` in the main Manim Studio repo) and
sends already-compiled segments (Python source, per-segment scene class
name, and a content hash) over the wire. This agent's only job is: decide
which segments it's already rendered before (reuse the cached clip) vs
which are new (run `manim`), stitch the results together, and report
progress in the same shape the site's cloud-render UI already understands.

See `src/shared/protocol.ts` for the exact WebSocket message shapes
(`start` / `cancel` / `ping` / `list-renders` / `rename-render` /
`delete-render` from the browser, `hello` / `job` / `render-list` / `error`
back), deliberately kept as a close analog of the website's existing
`POST /api/render` → `GET /api/render/[id]` → `GET /api/render/[id]/video`
HTTP flow, so the same render-progress UI can drive either backend.

### Incremental rendering (segment caching)

Manim has no time-seek mechanism — a scene's state at time T depends on
everything that happened before T. So re-rendering only the CHANGED part
of a long timeline isn't "render frames 300-450"; it's "recompile the
timeline into independently-renderable pieces, cut only at moments where
the scene is fully at rest" (no animation in flight, no transform
mid-morph, no active physics). The website's `src/lib/compiler/segments.ts`
does that analysis and compiles each piece; this agent just hashes each
segment's Python and looks the hash up in `src/main/segmentCache.ts` (a
flat, content-addressed store under userData, LRU-evicted past 4 GB).
Unchanged earlier segments hash identically to their last render and are
never re-run through Manim — only the segment(s) a user actually edited
get rendered again. The pieces are joined with FFmpeg's concat demuxer in
stream-copy mode (no re-encode, since every segment shares the same
codec/resolution/fps), which is both lossless and fast.

### The local render library ("Cloud renders")

Every finished render is kept, named, and browsable — `src/main/
renderLibrary.ts` maintains a manifest of every video this agent has ever
produced, entirely on this machine. The website's editor sidebar has a
"Cloud renders" tab (named for the always-on-in-the-background feel the
user experiences, not because anything is actually uploaded) that lists,
renames, previews, downloads, and deletes these — driven by the
`list-renders`/`rename-render`/`delete-render` protocol messages. **The
video files themselves never leave this computer.** Only lightweight
metadata (name, project, duration, file size, timestamp) is optionally
synced to the website (`src/main/librarySync.ts`, POSTs to
`/api/render-library`) when the user is signed in, so Manim Studio's admin
dashboard has visibility into render activity — never the video bytes.

### Why wss:// (encrypted), not ws://

Loopback traffic never leaves the machine, but "local" isn't the same
guarantee as "encrypted" — other local processes, a proxy tool sitting on
127.0.0.1, or a browser extension with raw socket access could otherwise
observe a compiled scene (which can embed a user's own text/labels/project
name) in transit. `src/main/tls.ts` generates a self-signed certificate
once per install (cached under userData, valid 10 years) and both the
WebSocket and the video server run over TLS on top of it.

## Account, notifications, and auto-update

- **Sign in** (status window → Account card): the SAME Firebase project and
  email/password login the website uses (`src/renderer/firebase.ts`) — not
  a separate account system. Runs in the status window's renderer process
  (not Electron's main process), because the Firebase Auth SDK needs a
  real browser `window`/`localStorage`, which only a renderer provides.
- **Notification center** (bell icon, status window): once signed in, pulls
  platform announcements from the website's `/api/notifications`
  (`src/renderer/notifications.ts`) — authored from the website's `/admin`
  dashboard's "Desktop agent notifications" section. Read-only from this
  app; publishing happens only on the website, by an admin.
- **Auto-update** (`src/main/updater.ts`, `electron-updater` +
  GitHub Releases): checks on launch and every 4 hours, downloads in the
  background, and shows an in-app "Restart & update" banner once ready —
  this is the "we send something to the user to update the app" mechanism.
  Configure via `UPDATE_REPO` in `.env` (see `.env.example`); leave unset to
  disable update checks entirely for a build.

None of these three are required for rendering to work — a signed-out user
with no `.env` Firebase config still gets a fully functional render agent;
sign-in/notifications/updates are additive.

## Project layout

```
src/
  main/
    index.ts          Electron entry point — tray icon, status window, lifecycle, global exception handlers
    wsServer.ts        The local wss:// server the browser connects to
    renderWorker.ts     Runs one render request: per-segment cache lookup, `manim render`, ffmpeg concat
    segmentCache.ts      Content-addressed cache of rendered segment clips (keyed by Python hash)
    renderLibrary.ts      The local render library manifest — every finished video, named, on this machine
    librarySync.ts          Best-effort METADATA-only sync to the site's /api/render-library
    videoServer.ts      Local HTTPS server for finished videos (Range support)
    runtimeCheck.ts      Functional "is the bundled runtime actually working" check
    tls.ts                 Self-signed TLS certificate, generated once and cached
    updater.ts              electron-updater wiring (GitHub Releases)
    authToken.ts             Holds the renderer's current Firebase ID token, for librarySync.ts
    paths.ts                  Where every bundled binary and per-user file lives
    proc.ts                     Shared no-shell process-spawn helper (Windows path safety)
    progressParse.ts             Manim stdout/stderr progress-percentage parsing
    logger.ts                     Append-only file logger (agent.log under userData)
    statusApi.ts                   IPC handlers for the status window
  renderer/
    index.html, status.js, preload.ts   The tray's status window: runtime checklist + logs
    app.ts, firebase.ts, notifications.ts   Account sign-in, notification center, update banner
                                              (bundled by esbuild — see scripts/bundle-renderer.js —
                                               since these pull in the Firebase SDK)
  shared/
    protocol.ts        WebSocket message types shared by main + (conceptually) the site
    firebaseConfig.ts    Re-exports the build-time-generated Firebase config (see below)

scripts/
  prepare-runtime.js   Build-time only — assembles resources/runtime/* before packaging
  generate-firebase-config.js   Reads .env → src/shared/firebaseConfig.generated.ts
  bundle-renderer.js     esbuild bundle of app.ts for the browser-context status window
  copy-static.js          Copies renderer HTML/plain-JS into dist/ after tsc (build-only)
  generate-icons.js        Rasterizes build/assets/logo.svg into icon.ico + tray-icon.png

resources/
  runtime/             Populated by prepare-runtime.js; bundled into the installer
build/
  installer.nsh, license.txt   NSIS welcome/license pages explaining what this app is/does
```

## Building it yourself

```powershell
npm install
copy .env.example .env      # fill in Firebase web config + UPDATE_REPO (optional — see .env.example)
npm run generate-icons      # one-time, or whenever build/assets/logo.svg changes
npm run prepare-runtime     # one-time, downloads/builds resources/runtime/* — several hundred MB, several minutes
npm run dist:win            # produces release/*.exe — the actual installer, fully self-contained
```

For local development without packaging:

```powershell
npm install
copy .env.example .env
npm run prepare-runtime   # still needed once — the dev app reads resources/runtime the same way
npm run dev               # tsc --watch + electron, both together
```

`npm run typecheck` and `npm run lint` run independently of the runtime
bundle and the `.env` config — useful for iterating on the TypeScript
without waiting on downloads or filling in real Firebase credentials first.
Skipping `.env` entirely is fine too: the app builds and runs, just without
sign-in/notifications/auto-update.

## What the website side needs to do

The Manim Studio website repo has its own client-side addition for this —
`src/lib/localAgent.ts` (WebSocket client + agent-detection state machine +
segment planning via `src/lib/compiler/segments.ts`), agent-aware UI in
`RenderDialog.tsx`, a "Cloud renders" sidebar tab (`CloudRendersPanel.tsx`),
plus the `/admin` "Desktop agent notifications" and "Local renders"
sections and the `/api/notifications` / `/api/render-library` routes — see
that repo directly; this repo only ships the agent + documents the
protocol here for reference:

```ts
const ws = new WebSocket(`wss://127.0.0.1:${port}`); // TLS — see tls.ts
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data); // HelloMessage | JobMessage | RenderListMessage | ErrorMessage
  // msg.type === "hello"       → the AGENT was detected (not just "a port") — see below
  // msg.type === "job"         → same RenderJob-shaped progress the cloud path already renders,
  //                              plus segmentsTotal/segmentsCached ("3 of 4 segments cached")
  // msg.type === "render-list" → the local render library's current contents
};
ws.send(JSON.stringify({
  type: "start",
  requestId: crypto.randomUUID(),
  projectId: project.id,
  projectName: project.name,
  segments: await planRenderSegments(project), // splits + hashes at safe cut points
  outputFormat: project.settings.outputFormat,
}));
```

If the socket fails to connect (agent not running / not installed), the
site falls back to its existing cloud render path — this agent is an
additional option, never a hard dependency.

**On wording**: the site should always say the *application* was or wasn't
detected ("Local render agent detected" / "not detected — install it from
…"), never phrase this in terms of "a port" being found — a port existing
says nothing about whether Manim actually works on the other end of it;
only a successful `hello` handshake (with `ready: true`) means the agent
and its runtime are both actually there.

## Why no first-run download

An earlier draft of this agent downloaded Python/LaTeX/FFmpeg on first
launch. That was deliberately reworked: the requirement is that installing
this app is the *only* thing a user ever does — no waiting on a background
install, no extra network dependency at the moment they actually want to
render, no risk of a corporate/school network blocking the download
mid-setup. Everything ships inside the installer instead, at the cost of a
larger download and a slower *build* (paid once, by whoever cuts a release,
via `prepare-runtime.js`) — never a slower first run for the user.

## Logs & diagnostics

- `%APPDATA%\Manim Studio Render Agent\agent.log` — full running log,
  including every `uncaughtException`/`unhandledRejection` the process
  hits (see `src/main/index.ts`) — the agent is designed to log and stay
  up rather than silently crash.
- Tray icon → **Open status window** — shows whether Python/Manim, LaTeX,
  and FFmpeg all check out, the account/notification center, the update
  banner, and the last ~200 log lines.
- Tray icon → **Verify install** — re-runs the functional runtime check
  on demand (useful after an antivirus quarantine or a disk issue).
