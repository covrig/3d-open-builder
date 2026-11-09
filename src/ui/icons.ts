import {
  AlignEndHorizontal, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart,
  AlignHorizontalSpaceAround, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart,
  AlignVerticalSpaceAround, Angle, ArrowDownFromLine, ArrowDownToLine, Axis3d, Bolt, Box, ChevronDown,
  ChevronRight, ChevronUp, Circle, CircleDashed, CircleDot, ClipboardPaste, Cone, Copy, CopyPlus, Cylinder,
  Dome, Download, Eraser, FilePlus, FlipHorizontal2, Focus, FolderOpen, Ghost, Globe, Group, Hexagon,
  House, Image, Info, Keyboard, LayoutDashboard, LayoutGrid, ListChecks, LocateFixed, Lock, LockOpen, Menu,
  Move, PanelBottom, PanelRightOpen, PencilRuler, Pipette, Plus, Pyramid, Redo2, RefreshCw, Rotate3d,
  RotateCcw, RotateCw, ScanLine, SquareDashedBottom, ArrowUpDown, Ruler, Save, Scan, Scissors, ScissorsLineDashed, Settings, Shield, ShieldCheck,
  SquareDashed, SquaresIntersect, SquaresSubtract, SquaresUnite, Squircle, Sun, Torus, Trash2, Triangle,
  TriangleRight, Type, Undo2, Ungroup, Wrench,
  createElement, createIcons, type IconNode,
} from 'lucide';

// Only the icons we use are imported, so the bundle stays small.
const ICONS: Record<string, IconNode> = {
  AlignEndHorizontal, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart,
  AlignHorizontalSpaceAround, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart,
  AlignVerticalSpaceAround, Angle, ArrowDownFromLine, ArrowDownToLine, Axis3d, Bolt, Box, ChevronDown,
  ChevronRight, ChevronUp, Circle, CircleDashed, CircleDot, ClipboardPaste, Cone, Copy, CopyPlus, Cylinder,
  Dome, Download, Eraser, FilePlus, FlipHorizontal2, Focus, FolderOpen, Ghost, Globe, Group, Hexagon,
  House, Image, Info, Keyboard, LayoutDashboard, LayoutGrid, ListChecks, LocateFixed, Lock, LockOpen, Menu,
  Move, PanelBottom, PanelRightOpen, PencilRuler, Pipette, Plus, Pyramid, Redo2, RefreshCw, Rotate3d,
  RotateCcw, RotateCw, ScanLine, SquareDashedBottom, ArrowUpDown, Ruler, Save, Scan, Scissors, ScissorsLineDashed, Settings, Shield, ShieldCheck,
  SquareDashed, SquaresIntersect, SquaresSubtract, SquaresUnite, Squircle, Sun, Torus, Trash2, Triangle,
  TriangleRight, Type, Undo2, Ungroup, Wrench,
};

/** A fresh SVG element for an icon (for elements created in code). */
export function icon(name: string): SVGElement {
  const node = ICONS[pascal(name)];
  if (!node) throw new Error(`Icon "${name}" is not registered`);
  return createElement(node, { 'aria-hidden': 'true' });
}

const pascal = (kebab: string) =>
  kebab.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

/** Replace every <i data-lucide="name"> in the page with its SVG. */
export function renderIcons(): void {
  createIcons({ icons: ICONS, attrs: { 'aria-hidden': 'true' } });
}

/** Swap the icon inside a button. */
export function setIcon(button: HTMLElement, name: string): void {
  const node = ICONS[pascal(name)];
  if (!node) throw new Error(`Icon "${name}" is not registered`);
  const svg = createElement(node, { 'aria-hidden': 'true' });
  const old = button.querySelector('svg');
  if (old) old.replaceWith(svg);
  else button.prepend(svg);
}
