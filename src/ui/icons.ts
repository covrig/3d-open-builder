import {
  AlignEndHorizontal, Angle, ArrowDownFromLine, ArrowDownToLine, Axis3d, Box, ChevronDown, CircleDashed, CircleDot, Layers,
  CircleQuestionMark, ClipboardPaste, Circle, Cone, Copy, CopyPlus, Cylinder, Dome, Download, Eraser,
  File, FilePlus, FlipHorizontal2, Focus, FolderOpen, Ghost, Globe, Grid3x3, Group, Hexagon, LocateFixed,
  Lock, LockOpen, Move, PanelBottom, Pipette, Plus, Pyramid, Redo2, RotateCcw, RotateCw, Ruler, Save,
  Scan, Scissors, ScissorsLineDashed, Settings, Shield, SquareDashed, SquaresIntersect, SquaresSubtract,
  SquaresUnite, Sun, Torus, Trash2, TriangleRight, Undo2, Ungroup,
  Info, Keyboard, ShieldCheck, Sparkles, Spline, Squircle, Triangle, Wrench,
  LayoutGrid, PencilRuler, RectangleVertical, Type, Image, Bolt, Rotate3d, Menu, PanelRight,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  AlignHorizontalSpaceAround, AlignVerticalSpaceAround, LayoutDashboard, Crosshair, MoveHorizontal,
  House, RefreshCw, ChevronUp, X, ListChecks, PanelRightOpen, ChevronRight,
  createElement, createIcons, type IconNode,
} from 'lucide';

// Only the icons we use are imported, so the bundle stays small.
const ICONS: Record<string, IconNode> = {
  AlignEndHorizontal, Angle, ArrowDownFromLine, ArrowDownToLine, Axis3d, Box, ChevronDown, CircleDashed, CircleDot, Layers,
  CircleQuestionMark, ClipboardPaste, Circle, Cone, Copy, CopyPlus, Cylinder, Dome, Download, Eraser,
  File, FilePlus, FlipHorizontal2, Focus, FolderOpen, Ghost, Globe, Grid3x3, Group, Hexagon, LocateFixed,
  Lock, LockOpen, Move, PanelBottom, Pipette, Plus, Pyramid, Redo2, RotateCcw, RotateCw, Ruler, Save,
  Scan, Scissors, ScissorsLineDashed, Settings, Shield, SquareDashed, SquaresIntersect, SquaresSubtract,
  SquaresUnite, Sun, Torus, Trash2, TriangleRight, Undo2, Ungroup,
  Info, Keyboard, ShieldCheck, Sparkles, Spline, Squircle, Triangle, Wrench,
  LayoutGrid, PencilRuler, RectangleVertical, Type, Image, Bolt, Rotate3d, Menu, PanelRight,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  AlignHorizontalSpaceAround, AlignVerticalSpaceAround, LayoutDashboard, Crosshair, MoveHorizontal,
  House, RefreshCw, ChevronUp, X, ListChecks, PanelRightOpen, ChevronRight,
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
