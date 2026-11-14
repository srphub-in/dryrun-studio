# Dry Run Studio (v1.0.0)

> Test your production builds on localhost before pushing to the cloud.  
> Built by **[SRP Hub (srphub.in)](https://srphub.in)** • MIT License

**Dry Run Studio** is a local sandbox and deployment tool for modern web projects (Astro, Vite, React, Vue, Next.js, SvelteKit, and standard Node/static setups). 

If you keep your projects in cloud-synced folders like Google Drive or OneDrive, you know how quickly `node_modules` and `dist/` folders ruin sync performance. Dry Run Studio copies your project into an isolated temporary workspace, runs a full production build and pre-flight check, and leaves your original source folder completely untouched. Once everything looks good, you can push to GitHub and monitor Cloudflare Pages deployments right from the dashboard.

---

## Why use it?

* **Keeps your source folder clean:** Your project directory stays 100% read-only. Package installs, build artifacts, and temporary caches happen inside a separate sandbox directory that wipes itself clean when you exit.
* **Built-in diff viewer (no Git required):** Takes automatic snapshots of your working builds so you can compare red/green line-by-line code changes between your last baseline and your current build. When a cloud deployment succeeds, your current build automatically becomes the new baseline.
* **Pre-flight checks & live error catching:** Before building, it scans your code for leaked API keys, leftover `debugger;` statements, and unresolved merge conflict markers (`<<<<<<< HEAD`). After building, it crawls your generated HTML to verify that local JS, CSS, font, and image assets aren't broken, while catching runtime JS exceptions and `404`s during live preview.
* **One-click bug reports:** If a build fails or throws runtime errors, you can export the compiler logs, stack traces, code diffs, and bundle sizes into a single Markdown (`.md`) file.
* **GitHub & Cloudflare Pages integration:** Saves your per-project repo remotes and Cloudflare credentials locally using Windows DPAPI (`ProtectedData`) encryption tied to your Windows login. You can verify Git auth, commit and push, watch live Cloudflare build logs, and retry failed deployments without leaving the app.

---

## Getting Started (Windows 10 / 11)

### Requirements
* **[Node.js LTS](https://nodejs.org/)** (v18 or v20+ recommended)
* **[Git for Windows](https://git-scm.com/)** *(Optional — only needed if you use the Cloud Deploy tab)*

### Running from the repo
1. Clone this repo or download and extract the `.zip`.
2. Double-click **`Launch-Studio.bat`**.
3. On your first run, pick a folder for your temporary Sandbox Workspace and choose whether you want Desktop or Start Menu shortcuts.

### Building the single-file portable version
If you want to carry the whole tool on a thumb drive or drop it onto another machine as a single file:
1. Double-click **`Pack-Portable-Single.bat`**.
2. Grab the bundled script from **`dist-portable/DryRun-Studio-v1.0.0-Portable.bat`** (it packs `src/`, `LICENSE`, and the launcher into one self-contained `.bat` file).

---

## Project Structure

```text
dryrun-studio/
├── Launch-Studio.bat           # Main desktop launcher
├── Pack-Portable-Single.bat    # Bundles the repo into a single portable .bat file
├── README.md                   # Documentation
├── LICENSE                     # MIT License (© 2026 SRP Hub)
├── src/
│   ├── server.mjs              # Localhost HTTP/SSE server & API router
│   ├── sandbox-engine.mjs      # Sandbox builder, baseline snapshots, diffing & smoke tests
│   ├── cloud-deployer.mjs      # Windows DPAPI credential vault, Git auth & Cloudflare poller
│   └── ui.html                 # Dashboard interface & 3s splash screen
└── docs/                       # GitHub Pages site (dryrun.srphub.in)
    ├── CNAME
    └── index.html
```

---

## License

Released under the [MIT License](./LICENSE).  
© 2026 [SRP Hub (srphub.in)](https://srphub.in) — free to use, modify, and distribute.