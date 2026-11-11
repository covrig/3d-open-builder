# Vendored libraries

Every library that ends up in the app is stored here as an npm package
tarball, and `package.json` installs it from this folder (`file:vendor/…`).
The app therefore never depends on the npm registry or a CDN: an upstream
release, unpublish or outage cannot change or break it.

| File | Source | Licence |
|---|---|---|
| `three-0.187.0.tgz` | `npm pack three@0.187.0` | MIT |
| `fflate-0.8.3.tgz` | `npm pack fflate@0.8.3` | MIT |
| `lucide-1.70.0.tgz` | `npm pack lucide@1.70.0` | ISC |
| `opentype.js-2.0.0.tgz` | `npm pack opentype.js@2.0.0` | MIT |
| `three-mesh-bvh-0.9.16.tgz` | `npm pack three-mesh-bvh@0.9.16` | MIT |
| `manifold-3d-3.5.4.tgz` | minimal repack of `manifold-3d@3.5.4`: only `manifold.js`, `manifold.wasm`, `manifold.d.ts`, `LICENSE`, `README.md` | Apache-2.0 |

The manifold-3d repack leaves out the ManifoldCAD editor tooling, whose extra
dependencies the app does not use and which would otherwise still be fetched
from the registry.

Fonts for embossed text live in `public/fonts/` with their licence files.

Build tools (Vite, TypeScript, Vitest, happy-dom) are not shipped to users and
are installed normally as dev dependencies, pinned by `package-lock.json`.

To update a library: replace its tarball, update `package.json`, run
`npm install` and `npm run licenses`.
