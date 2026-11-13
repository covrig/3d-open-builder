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

## Features

- **Shapes and threads:** basic shapes with their measurements set before they are added, plus bolts, nuts and threads (also for cutting threaded holes) in metric and imperial sizes.
- **Combine and edit:** merge, subtract and intersect, split, mirror and rotate in quarter turns, pattern, extrude down to the plate, shell, edge bevel and rounding, braces, and raised or cut-in text. Groups work with move, mirror, split, extrude and pattern.
- **Place precisely:** move, rotate and size handles with snapping, put on the plate, lay flat, align, distribute and pack, and a reference picture to trace over.
- **Measure and look inside:** distance, angle and circle measuring that snaps to corners, edges, edge middles and the lines where objects overlap; a section view that cuts the view open, with measuring on the cut.
- **Ready to print:** print check with automatic repair (it never alters a model that is already sound), overhangs shown in colour, best print orientation, and export to 3MF (with colours) or STL under a name you choose. Imports 3MF, STL and OBJ.
- **See it your way:** X-ray, wireframe, edges (with faint lines where objects overlap) and shadows, rulers, a view cube, hide objects you don't need right now, and light or dark themes.
- **Any device:** mouse, trackpad or touch, with Home, Select several and Delete buttons on touch screens; on desktop, optional single-key shortcuts and a key to repeat the last tool.
- **Safe to use:** 100 undo steps, autosave/save, and saving the whole drawing to a project file you can open again.

## Private by design

Everything runs on your own device: no uploads, no tracking, no cookies, no
accounts. Your drawing and settings are kept in your browser's own storage so
they are there next time. The full statement is in the app under Menu → Privacy.

## What's where

You only need the link above to use the app. If you want to look around this
repository, this is what each part is for.

**If you just want to look around**

| Where | What it is |
|---|---|
| [`README.md`](README.md) | This page. |
| [`LICENSE`](LICENSE) | The app's licence (MIT): you may use, copy and change it freely. |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | The libraries and fonts the app is built with, and their licences. |
| [`docs/`](docs) | The picture at the top of this page, and [`tool-rules.md`](docs/tool-rules.md): how tools start and end, and what still works while one is open. |
| [`index.html`](index.html) | The page your browser opens: the toolbar, the side panel and the dialog boxes. |
| [`public/`](public) | Files used exactly as they are: the app icon, the three fonts for text on objects, and the licence texts. |

**For developers**

| Where | What it is |
|---|---|
| [`src/`](src) | The app itself (in TypeScript). [`src/main.ts`](src/main.ts) starts it and connects the buttons to the features. |
| [`src/geometry/`](src/geometry) | The maths that makes and changes shapes: basic shapes, threads, text, merge and the other combinations, splitting, rounding edges, checking and repairing models. It has no buttons or screens; the heavy work runs in the background so the page never freezes. |
| [`src/scene/`](src/scene) | The 3D view: camera, build plate, shadows and reflection, the move/rotate/size handles, and the list of objects with undo and redo. |
| [`src/ui/`](src/ui) | Everything you click: menus, the side panel, tool bars, tooltips, and the tools that work by clicking in the view (measuring, picking edges, cross section). |
| [`src/io/`](src/io) | Opening and saving 3MF, STL and OBJ files. |
| [`src/app/`](src/app) | Autosave, and getting your work back after a problem. |
| [`src/style.css`](src/style.css) | How the app looks, in light and dark colours. |
| [`tests/`](tests) | Automatic tests for the geometry, the file formats and saving. |
| [`scripts/`](scripts) | Helper scripts: checks in real Chrome, Edge and Firefox, and collecting the library licences. |
| [`vendor/`](vendor) | Copies of the libraries the app uses, kept here so nothing is downloaded from other sites (see [`vendor/README.md`](vendor/README.md)). |
| [`.github/workflows/`](.github/workflows) | Tests the app and publishes the website after every change. |
| `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json` | Settings for building the app, and the exact library versions. |

## Licence

MIT — see [LICENSE](LICENSE). The bundled libraries and fonts keep their own
licences: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), or Menu →
About and libraries in the app.

## Run it locally

Requires Node.js 26 or newer.

```bash
npm install
npm run dev      # http://localhost:5173
```

`npm test` runs the unit tests, `npm run check:browsers` runs automated checks
in the installed Chrome, Edge and Firefox, and `npm run build` creates the site
in `dist/`. Every push to `main` is tested and published to GitHub Pages.
