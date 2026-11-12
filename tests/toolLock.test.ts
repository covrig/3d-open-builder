import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cancelAll } = vi.hoisted(() => ({ cancelAll: vi.fn() }));
vi.mock('../src/geometry/workerClient', () => ({ cancelAll }));

// The lock keeps its state in the module, so every test gets a fresh copy.
let lock: typeof import('../src/ui/toolLock');
beforeEach(async () => {
  cancelAll.mockClear();
  vi.resetModules();
  lock = await import('../src/ui/toolLock');
});

/** A tool whose stop() ends it, like the real ones. */
function tool(name: string, kind: 'exclusive' | 'light' | 'view') {
  const stop = vi.fn(() => {
    if (kind === 'view') lock.endViewTool(name);
    else lock.endTool(name);
  });
  const begin = () => {
    if (kind === 'view') lock.beginViewTool(name, stop);
    else lock.beginTool(name, stop, kind === 'exclusive');
  };
  return { stop, begin };
}

describe('tool lock', () => {
  it('starting a second tool stops the first', () => {
    const a = tool('a', 'exclusive');
    const b = tool('b', 'exclusive');
    a.begin();
    b.begin();
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).not.toHaveBeenCalled();
    expect(lock.isToolOpen()).toBe(true);
    expect(lock.isLocked()).toBe(true);
  });

  it('starting the same tool again does not stop it', () => {
    const a = tool('a', 'exclusive');
    a.begin();
    a.begin();
    expect(a.stop).not.toHaveBeenCalled();
  });

  it('an exclusive tool stops an open view tool, a light tool does not', () => {
    const view = tool('section', 'view');
    const measure = tool('measure', 'light');
    const edit = tool('edit', 'exclusive');
    view.begin();
    measure.begin();
    expect(view.stop).not.toHaveBeenCalled();
    edit.begin();
    expect(view.stop).toHaveBeenCalledTimes(1);
    expect(measure.stop).toHaveBeenCalledTimes(1); // replaced as the one current tool
    expect(lock.onlyViewLocked()).toBe(false);
  });

  it('a second view tool stops the first view tool', () => {
    const a = tool('section', 'view');
    const b = tool('overhangs', 'view');
    a.begin();
    b.begin();
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).not.toHaveBeenCalled();
  });

  it('isLocked is true for an exclusive tool and a view tool, false for a light tool', () => {
    expect(lock.isLocked()).toBe(false);
    const light = tool('measure', 'light');
    light.begin();
    expect(lock.isToolOpen()).toBe(true);
    expect(lock.isLocked()).toBe(false);
    lock.endTool('measure');

    tool('edit', 'exclusive').begin();
    expect(lock.isLocked()).toBe(true);
    lock.endTool('edit');
    expect(lock.isLocked()).toBe(false);

    tool('section', 'view').begin();
    expect(lock.isLocked()).toBe(true);
    lock.endViewTool('section');
    expect(lock.isLocked()).toBe(false);
  });

  it('onlyViewLocked: a view tool alone, but not with an exclusive tool', () => {
    expect(lock.onlyViewLocked()).toBe(false);
    tool('section', 'view').begin();
    expect(lock.onlyViewLocked()).toBe(true);
    tool('measure', 'light').begin();
    expect(lock.onlyViewLocked()).toBe(true); // measuring still works beside a view tool
    lock.endTool('measure');
    lock.endViewTool('section');
    expect(lock.onlyViewLocked()).toBe(false);
  });

  it('stopActiveTool returns false with nothing open, true after stopping one', () => {
    expect(lock.stopActiveTool()).toBe(false);
    const a = tool('a', 'exclusive');
    a.begin();
    expect(lock.stopActiveTool()).toBe(true);
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(lock.isToolOpen()).toBe(false);
    expect(lock.stopActiveTool()).toBe(false);
  });

  it('stopActiveTool lets go of a tool whose stop did not end it, and leaves a view tool open', () => {
    lock.beginTool('stubborn', () => {}, true);
    expect(lock.stopActiveTool()).toBe(true);
    expect(lock.isToolOpen()).toBe(false);

    const view = tool('section', 'view');
    view.begin();
    expect(lock.stopActiveTool()).toBe(false);
    expect(view.stop).not.toHaveBeenCalled();
  });

  it('endTool for a tool that is not the current one does nothing', () => {
    const a = tool('a', 'exclusive');
    a.begin();
    const seen = vi.fn();
    lock.onToolChange(seen);
    lock.endTool('other');
    expect(seen).not.toHaveBeenCalled();
    expect(lock.isToolOpen()).toBe(true);
    expect(cancelAll).not.toHaveBeenCalled();
  });

  it('ending an exclusive tool stops the background calculation, ending a light one does not', () => {
    tool('edit', 'exclusive').begin();
    lock.endTool('edit');
    expect(cancelAll).toHaveBeenCalledTimes(1);
    tool('measure', 'light').begin();
    lock.endTool('measure');
    expect(cancelAll).toHaveBeenCalledTimes(1);
  });

  it('listeners hear every open and close', () => {
    const seen = vi.fn();
    lock.onToolChange(seen);
    tool('a', 'exclusive').begin();
    expect(seen).toHaveBeenCalledTimes(1);
    lock.endTool('a');
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('setBusy and isBusy notify once per change', () => {
    const seen = vi.fn();
    lock.onToolChange(seen);
    expect(lock.isBusy()).toBe(false);
    lock.setBusy(false); // no change
    expect(seen).not.toHaveBeenCalled();
    lock.setBusy(true);
    lock.setBusy(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(lock.isBusy()).toBe(true);
    lock.setBusy(false);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(lock.isBusy()).toBe(false);
  });
});
