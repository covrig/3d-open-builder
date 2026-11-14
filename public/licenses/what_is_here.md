# What's where

You only need the link in the [README](../../README.md) to use the app. If you want to look around this
repository, this is what each part is for.

**If you just want to look around**

| Where | What it is |
|---|---|
| [`README.md`](../../README.md) | The front page of the repository: what the app does, and links to this file. |
| [`LICENSE`](../../LICENSE) | The app's licence (MIT): you may use, copy and change it freely. |
| [`docs/`](../../docs) | The picture at the top of the README, and [`tool-rules.md`](../../docs/tool-rules.md): how tools start and end, and what still works while one is open. |
| [`index.html`](../../index.html) | The page your browser opens: the toolbar, the side panel and the dialog boxes. |
| [`public/`](..) | Files used exactly as they are: the app icon, the three fonts for text on objects, and the licence texts of the libraries and fonts (with [`third_party_notices.md`](third_party_notices.md), the list of what the app is built with). |

**For developers**

| Where | What it is |
|---|---|
| [`src/`](../../src) | The app itself (in TypeScript). [`src/main.ts`](../../src/main.ts) starts it and connects the buttons to the features. |
| [`src/geometry/`](../../src/geometry) | The maths that makes and changes shapes: basic shapes, threads, text, merge and the other combinations, splitting, rounding edges, checking and repairing models. It has no buttons or screens; the heavy work runs in the background so the page never freezes. |
| [`src/scene/`](../../src/scene) | The 3D view: camera, build plate, shadows and reflection, the move/rotate/size handles, and the list of objects with undo and redo. |
| [`src/ui/`](../../src/ui) | Everything you click: menus, the side panel, tool bars, tooltips, and the tools that work by clicking in the view (measuring, picking edges, cross section). |
| [`src/io/`](../../src/io) | Opening and saving 3MF, STL and OBJ files. |
| [`src/app/`](../../src/app) | Autosave, and getting your work back after a problem. |
| [`src/style.css`](../../src/style.css) | How the app looks, in light and dark colours. |
| [`tests/`](../../tests) | Automatic tests for the geometry, the file formats and saving. |
| [`scripts/`](../../scripts) | Helper scripts: checks in real Chrome, Edge and Firefox, and collecting the library licences. |
| [`vendor/`](../../vendor) | Copies of the libraries the app uses, kept here so nothing is downloaded from other sites (see [`vendor/README.md`](../../vendor/README.md)). |
| [`.github/workflows/`](../../.github/workflows) | Tests the app and publishes the website after every change. |
| `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json` | Settings for building the app, and the exact library versions. |
