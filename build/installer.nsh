; Custom NSIS branding for the Manim Studio Render Agent installer.
; electron-builder includes this automatically when build.nsis.include
; points here (see package.json). Adds a welcome page explaining what the
; product IS and DOES before the user commits to installing it — this
; agent runs quietly in the background and talks to a website, which is
; exactly the kind of thing a user should be told plainly about up front,
; not discover after the fact.

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Manim Studio Render Agent"
  !define MUI_WELCOMEPAGE_TEXT "This installs a small background helper for $\r$\n$\r$\nhttps://manim-std.vercel.app$\r$\n$\r$\nWhat it does:$\r$\n  - Renders your Manim Studio videos on THIS computer, using Python, Manim, LaTeX, and FFmpeg bundled inside this installer$\r$\n  - Is detected automatically by the website when it's running, and used only when you choose local rendering there$\r$\n  - Talks to the website over an encrypted local connection (wss://127.0.0.1) - nothing renders anywhere else$\r$\n  - Runs quietly in the system tray; you can open its status window any time to check what's happening$\r$\n  - Can check for its own updates and, if you sign in with your Manim Studio account, show notifications from Manim Studio$\r$\n$\r$\nNothing else is installed, and no other application on this computer is modified.$\r$\n$\r$\nClick Next to continue."
!macroend
