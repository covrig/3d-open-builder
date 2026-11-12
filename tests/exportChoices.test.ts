// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { exportSummary, exportTargets } from '../src/app/fileActions';
import { settings } from '../src/settings';

const base = { total: 3, hidden: 0, includeHidden: false, notSolid: [] as string[], checking: 0 };

describe('exportTargets', () => {
  const objects = [{ id: 1 }, { id: 2, hidden: true }, { id: 3, hidden: false }];
  it('leaves hidden objects out unless asked', () => {
    expect(exportTargets(objects, false).map((o) => o.id)).toEqual([1, 3]);
    expect(exportTargets(objects, true).map((o) => o.id)).toEqual([1, 2, 3]);
  });
  it('returns a new list', () => {
    expect(exportTargets(objects, true)).not.toBe(objects);
  });
});

describe('exportSummary', () => {
  it('counts the objects', () => {
    expect(exportSummary(base)).toBe('3 objects will be exported.');
    expect(exportSummary({ ...base, total: 1 })).toBe('1 object will be exported.');
  });
  it('says how many hidden objects are left out', () => {
    expect(exportSummary({ ...base, hidden: 1 })).toBe('2 objects will be exported; 1 hidden object is left out.');
    expect(exportSummary({ ...base, total: 4, hidden: 2 })).toBe('2 objects will be exported; 2 hidden objects are left out.');
  });
  it('counts hidden objects when they are included', () => {
    expect(exportSummary({ ...base, hidden: 1, includeHidden: true })).toBe('3 objects will be exported.');
  });
  it('lists objects that are not closed solids, three at most', () => {
    const warn = ' A slicer may refuse them; Check and Repair can fix most.';
    expect(exportSummary({ ...base, notSolid: ['A', 'B'] })).toBe(`3 objects will be exported. Not closed solids: A, B.${warn}`);
    expect(exportSummary({ ...base, notSolid: ['A', 'B', 'C'] })).toBe(`3 objects will be exported. Not closed solids: A, B, C.${warn}`);
    expect(exportSummary({ ...base, total: 6, notSolid: ['A', 'B', 'C', 'D', 'E'] }))
      .toBe(`6 objects will be exported. Not closed solids: A, B, C and 2 more.${warn}`);
  });
  it('mentions large objects still being checked', () => {
    expect(exportSummary({ ...base, checking: 2 })).toBe('3 objects will be exported. 2 large objects are still being checked.');
    expect(exportSummary({ ...base, checking: 1 })).toBe('3 objects will be exported. 1 large object is still being checked.');
    expect(exportSummary({ ...base, notSolid: ['A'], checking: 1 })).toContain('Not a closed solid: A. A slicer may refuse it;');
  });
  it('says so when nothing is left to export', () => {
    expect(exportSummary({ ...base, hidden: 3 })).toBe('Nothing to export: every object is hidden.');
    expect(exportSummary({ ...base, total: 0 })).toBe('Nothing to export: every object is hidden.');
    expect(exportSummary({ ...base, hidden: 3, includeHidden: true })).toBe('3 objects will be exported.');
  });
});

describe('settings', () => {
  it('leaves hidden objects out of exports by default', () => {
    expect(settings.ui.exportHidden).toBe(false);
  });
});
