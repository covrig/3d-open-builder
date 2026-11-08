/**
 * Global error handling. Errors inside operations are caught where they
 * happen and shown as a short message. Anything that escapes (an uncaught
 * exception or rejected promise) or a lost graphics context may leave the
 * scene in a bad state, so the app offers to go back to the last save point.
 */
export interface ErrorHandlers {
  /** Return to the last autosave; resolves false if there is none. */
  restoreLastSave(): Promise<boolean>;
}

let dialogOpen = false;

export function installErrorHandlers(handlers: ErrorHandlers): void {
  const dialog = document.querySelector<HTMLDialogElement>('#error-dialog')!;
  const text = dialog.querySelector<HTMLElement>('#error-text')!;

  const fatal = (message: string) => {
    console.error(message);
    if (dialogOpen) return;
    dialogOpen = true;
    text.textContent = message;
    dialog.showModal();
  };

  dialog.addEventListener('close', async () => {
    dialogOpen = false;
    if (dialog.returnValue === 'restore') {
      const ok = await handlers.restoreLastSave().catch(() => false);
      if (!ok) location.reload();
    } else if (dialog.returnValue === 'reload') {
      location.reload();
    }
  });

  window.addEventListener('error', (e) => {
    // Resource load errors (e.g. an image) have no error object; ignore those.
    if (!e.error && !e.message) return;
    fatal(e.error instanceof Error ? e.error.message : String(e.message));
  });
  window.addEventListener('unhandledrejection', (e) => {
    fatal(e.reason instanceof Error ? e.reason.message : String(e.reason));
  });
}

/** Watch the WebGL canvas: if the GPU drops the context, treat it as fatal. */
export function watchGraphicsContext(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'The graphics card stopped drawing the 3D view (WebGL context lost).',
      error: new Error('The graphics card stopped drawing the 3D view (WebGL context lost).'),
    }));
  });
}
