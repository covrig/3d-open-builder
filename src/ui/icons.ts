import {
  AlignEndHorizontal, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart,
  AlignHorizontalSpaceAround, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart,
  AlignVerticalSpaceAround, Angle, ArrowDownFromLine, ArrowDownToLine, Axis3d, Bolt, Box, ChevronDown,
  ChevronRight, ChevronUp, Circle, CircleDashed, CircleDot, ClipboardPaste, Cone, Copy, CopyPlus, Cylinder,
  Dices, Dome, Download, Eraser, Eye, EyeOff, FilePlus, FlipHorizontal2, FlipVertical2, Focus, FolderOpen, Ghost, Globe, Grid3x3, Group, Hexagon,
  House, Image, Info, Keyboard, LayoutDashboard, LayoutGrid, ListChecks, LocateFixed, Lock, LockOpen, Menu,
  Move, PanelBottom, PanelRightOpen, PencilRuler, Pipette, Plus, Pyramid, Redo2, RefreshCw, Rotate3d,
  RotateCcw, RotateCw, ScanLine, SquareDashedBottom, ArrowUpDown, Ruler, Save, Scan, Scissors, ScissorsLineDashed, Settings, Shield, ShieldCheck,
  SquareDashed, SquaresIntersect, SquaresSubtract, SquaresUnite, SquareRoundCorner, Sun, Torus, Trash2, Triangle,
  TriangleRight, Type, Undo2, Ungroup, Wrench,
  createElement, createIcons, type IconNode,
} from 'lucide';

// Lucide has no usable bevel (corner cut off by a diagonal) in this version: drawn
// here in the same format and stroke style as the library's icons.
const Bevel: IconNode = [['path', { d: 'M3 5a2 2 0 0 1 2-2h9l7 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]];
/** lucide's triangle-right turned the other way (this lucide version has no triangle-left). */
const TriangleLeft: IconNode = [['path', { d: 'M2 18a2 2 0 0 0 2 2h17c1.1 0 1.3-.6.4-1.3L3.6 4.3c-.9-.7-1.6-.4-1.6.7Z' }]];

// Only the icons we use are imported, so the bundle stays small.
const ICONS: Record<string, IconNode> = {
  AlignEndHorizontal, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart,
  AlignHorizontalSpaceAround, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart,
  AlignVerticalSpaceAround, Angle, ArrowDownFromLine, ArrowDownToLine, Axis3d, Bolt, Box, ChevronDown,
  ChevronRight, ChevronUp, Circle, CircleDashed, CircleDot, ClipboardPaste, Cone, Copy, CopyPlus, Cylinder,
  Dices, Dome, Download, Eraser, Eye, EyeOff, FilePlus, FlipHorizontal2, FlipVertical2, Focus, FolderOpen, Ghost, Globe, Grid3x3, Group, Hexagon,
  House, Image, Info, Keyboard, LayoutDashboard, LayoutGrid, ListChecks, LocateFixed, Lock, LockOpen, Menu,
  Move, PanelBottom, PanelRightOpen, PencilRuler, Pipette, Plus, Pyramid, Redo2, RefreshCw, Rotate3d,
  RotateCcw, RotateCw, ScanLine, SquareDashedBottom, ArrowUpDown, Ruler, Save, Scan, Scissors, ScissorsLineDashed, Settings, Shield, ShieldCheck,
  SquareDashed, SquaresIntersect, SquaresSubtract, SquaresUnite, SquareRoundCorner, Sun, Torus, Trash2, Triangle,
  TriangleRight, Type, Undo2, Ungroup, Wrench,
  Bevel, TriangleLeft,
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
