import Module, { type ManifoldToplevel } from 'manifold-3d';
// Vite copies the .wasm into the build and gives us its final URL.
import wasmUrl from 'manifold-3d/manifold.wasm?url';

let loading: Promise<ManifoldToplevel> | undefined;

/** Load the Manifold WASM module once (browser only; tests load it directly). */
export function loadManifold(): Promise<ManifoldToplevel> {
  loading ??= Module({ locateFile: () => wasmUrl }).then((wasm) => {
    wasm.setup();
    return wasm;
  });
  return loading;
}
