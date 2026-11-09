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

## Groups (and several selected objects)

Selecting a part of a group selects the whole group.

| Operation | On a group | Behaviour |
|---|---|---|
| Move, rotate, size (handles, transform bar) | Yes | The group as a whole |
| Copy, cut, paste, duplicate, delete | Yes | All parts; copies form a new group |
| Mirror | Yes | Through the middle of the group: the parts swap sides as well as flip |
| On plate | Yes | The group's lowest point rests on the plate; parts keep their heights relative to each other |
| Lay flat | Yes | The group turns as a whole onto the largest flat side of all its parts together |
| Center, align, distribute, pack | Yes | The group counts as one piece |
| Pattern | Yes | Copies of the whole group |
| Split | Yes | One plane across the group; every part it crosses is split; the pieces on each side form their own group |
| Extrude down | Yes | One plane across the group; every part it crosses is extended down; parts it misses stay as they are |
| Merge | Yes | All parts become one object |
| Subtract, intersect | Yes | Clicking a part puts the whole group in the role |
| Check and Repair | Yes | Each part is checked and repaired |
| Colour | Yes | All parts, when the group is selected (a part's colour box in the list recolours just that part otherwise) |
| Edge bevel, edge rounding, shell, brace, text | No | Dimmed; "works on one object at a time": Merge the group first, or Ungroup and pick one part |
| Best print orientation | No | Same: the orientation is worked out for one object |

## Edge bevel and edge rounding

Edges are always picked one by one; there is no "all sharp edges" choice,
since on threads that means tens of thousands of edges. Both tools can be used
on the same object (bevel some edges, round others). Picking the many short
edges a bevel or rounding leaves behind and treating them again works, but is
slow and builds large meshes.