`icon.ico` and `tray-icon.png` here are generated from `assets/logo.svg` —
the same gradient "M" brand mark used on manim-std.vercel.app
(`src/app/icon.svg` in the main site repo) — via:

```
npm run generate-icons
```

Re-run that any time `assets/logo.svg` changes. Both generated files are
checked in (they're small and this keeps `npm run dist:win` reproducible
without requiring `sharp`/`png-to-ico` at packaging time), but they're
always safe to regenerate from the SVG source of truth.
