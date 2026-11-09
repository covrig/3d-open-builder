<div align="center">

<img src="public/icon.svg" width="72" alt="" />

# 3D Open Builder

**Free, open-source 3D modelling for 3D printing, right in your browser.**<br />
Nothing to install, no account, and your files never leave your computer.

### [**▶&nbsp; Open 3D Open Builder**](https://covrig.github.io/3d-open-builder/)

[![Test and deploy](https://github.com/covrig/3d-open-builder/actions/workflows/deploy.yml/badge.svg)](https://github.com/covrig/3d-open-builder/actions/workflows/deploy.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-2fb3a1)](LICENSE)
[![Runs in Chrome, Edge, Firefox](https://img.shields.io/badge/runs%20in-Chrome%20%C2%B7%20Edge%20%C2%B7%20Firefox-2fb3a1)](https://covrig.github.io/3d-open-builder/)

<a href="https://covrig.github.io/3d-open-builder/"><img src="docs/3dopenbuilder.png" width="820" alt="3D Open Builder: a torus on the build plate with the toolbar, move handles and side panel" /></a>

</div>

## What you can do

- **Shapes and threads:** basic shapes, plus bolts, nuts, threaded rods and threaded holes in metric and imperial sizes.
- **Combine and edit:** merge, subtract, intersect, split, mirror, pattern, extrude down to the plate, shell, edge bevel and rounding, braces, and raised or cut-in text (also on curved faces).
- **Place precisely:** move, rotate and size handles with snapping, align and distribute, lay flat, measuring tools, and a reference picture to trace over.
- **Print-ready:** print check with automatic repair, best print orientation, and export to 3MF (with colours) or STL. Imports 3MF, STL and OBJ.
- **Safe to use:** 100 undo steps, autosave, and works on desktop, tablet and phone.

## Private by design

Everything runs on your own device: no uploads, no tracking, no cookies, no
accounts. Your drawing and settings are kept in your browser's own storage so
they are there next time. The full statement is in the app under Menu → Privacy.

## What's where

| Path | Contents |
|---|---|
| `index.html` | The app page: toolbar, side panel, dialogs. |
| `src/` | The app's source code (TypeScript): |
| `src/main.ts` | Starts the app and connects the toolbar and side panel to the features. |
| `src/geometry/` | Pure geometry, no user interface: shapes, Merge/Subtract/Intersect, split, extrude, edge bevel and rounding (chamfer, fillet), brace, shell, threads, text, mesh check and repair. `worker.ts` runs the heavy operations in the background so the page stays responsive. |
| `src/scene/` | The 3D view: camera, ground grid, rulers, move/rotate/size handles, and the list of objects with undo/redo. |
| `src/ui/` | Toolbar menus, side panel sections, tooltips and the tools that take clicks in the view (measuring, picking edges, reference picture). |
| `src/io/` | Reading and writing 3MF, STL and OBJ files. |
| `src/app/` | Autosave, restore and error recovery. |
| `src/style.css` | The look of the app, in light and dark colours. |
| `docs/` | The screenshot at the top of this page, and `tool-rules.md`: how tools start and end, and what stays usable while one is open. |
| `public/` | Files served as they are: the app icon, fonts for text on faces, and the licence texts of the libraries used. |
| `tests/` | Unit tests for the geometry, file formats and saving. |
| `vendor/` | The libraries the app uses, stored in this repository so nothing is fetched from other sites — see `vendor/README.md`. They are: **three** (3D drawing), **manifold-3d** (solid geometry engine), **fflate** (zip, for 3MF files), **lucide** (icons) and **opentype.js** (reading fonts). |
| `scripts/` | Helper scripts for developers: listing library licences, cross-browser checks. |
| `.github/workflows/` | Builds, tests and publishes the site on every push. |
| `package.json` | Project settings and the commands below; `package-lock.json` pins exact versions. |
| `vite.config.ts`, `tsconfig.json` | Build and TypeScript settings. |

## Licence

MIT — see [LICENSE](LICENSE). Bundled libraries and fonts keep their own
licences (listed in the app under Menu → About and libraries).

## Run it locally

Requires Node.js 26 or newer.

```bash
npm install
npm run dev      # http://localhost:5173
```

`npm test` runs the unit tests, `npm run check:browsers` runs automated checks
in the installed Chrome, Edge and Firefox, and `npm run build` creates the site
in `dist/`. Every push to `main` is tested and published to GitHub Pages.
