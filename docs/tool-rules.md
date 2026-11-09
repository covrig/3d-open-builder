# Tool rules

How tools start, end and share the app. The code follows this table
(`src/ui/toolLock.ts`, `src/ui/toolGuard.ts`, the key handlers in `src/main.ts`).

## Kinds of tools

| Kind | Tools | Locks the rest? |
|---|---|---|
| Exclusive (has Apply/Cancel) | Split, Extrude, Pattern, Text, Edge bevel, Edge rounding, Shell, Brace, Subtract, Intersect, Add bolt/nut/rod, Threaded hole, reference picture Calibrate/Straighten | Yes |
| Light | Measuring, colour picking (Copy from object) | No |
| View panels | Cross section, Show overhangs | No |

Only one tool (exclusive or light) is open at a time: opening one closes the
other. View panels stay open alongside tools.

## Ending a tool

- An exclusive tool ends only with **Apply**, **Cancel** or **Esc**.
- **Esc** always works, wherever the keyboard focus is (a tool's own fields
  included) and whether single-key shortcuts are on or not. Order: an open
  dropdown menu closes first, then the open tool, then a view panel; with
  nothing open, Esc clears the selection. Dialogs close themselves.
- Clicks in the view that are not part of the tool's own work (picking a face,
  an edge, the objects for Subtract) change nothing while an exclusive tool is
  open: no selection change, no closing.
- Ending an exclusive tool (Apply, Cancel or Esc) also stops its calculation,
  so Cancel and Esc are the single cancel path. The "Working…" box is not
  shown next to a tool bar that already says "Working…"; inside Split it
  shows without its own Cancel button.

## What works while an exclusive tool is open

| Action | Allowed | Why |
|---|---|---|
| The tool's own bar, fields, handles and view clicks | Yes | It is the tool |
| Camera (turn, pan, zoom), view cube, Home, Fit, View toggles (X-ray, wireframe, edges, shadows) | Yes | Only the view changes |
| Side panel open/close, Settings, Export, About, Privacy, keyboard shortcuts panel | Yes | Nothing in the drawing changes |
| Copy (button, Ctrl+C) | Yes | Reads only |
| Measuring tools, Clear measurements | No | Opening another tool would end this one |
| Undo, redo | No | They rebuild the objects the tool works on |
| Cut, paste, delete, duplicate, select all/none/invert, group, ungroup, the object list | No | They change or remove what the tool works on |
| Other toolbar tools and menus (add, combine, edit, mirror, more, check) | No | One tool at a time |
| Arrange (on plate, lay flat, center, align, distribute, pack) | No | They move what the tool works on |
| Transform bar values, reset rotation, proportions lock | No | Same; the Move/Rotate handles stay available where the tool itself uses them (Threaded hole) |
| New drawing, Import, Reference picture | No | They replace or add to the drawing |
| Select several, Delete (corner buttons) | No | Selection and deleting |

Locked controls are dimmed, don't respond, and their tooltip and a message say
"Finish or cancel the current tool first (Apply, Cancel or Esc)". The toolbar
button of the open tool stays highlighted.

With a light tool or a view panel open, everything works as usual.
