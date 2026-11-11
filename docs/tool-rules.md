# Tool rules

How tools start, end and share the app. The code follows this table
(`src/ui/toolLock.ts`, `src/ui/toolGuard.ts`, the key handlers in `src/main.ts`).

## Kinds of tools

| Kind | Tools | Locks the rest? |
|---|---|---|
| Exclusive (has Apply/Cancel) | Split, Extrude, Pattern, Text, Bevel, Round, Brace, Shell, Intersect, Add shape (cube, cylinder…), Add bolt/nut/thread, reference picture Calibrate/Straighten | Yes |
| Light | Measuring, colour picking (Copy from object) | No |
| View tools | Section, Show overhangs | Yes, except measuring |

Only one tool (exclusive or light) is open at a time: opening one closes the
other. View tools have a slot of their own: one at a time (opening one closes
the other), and measuring works beside them.

## Ending a tool

- An exclusive tool ends only with **Apply**, **Cancel** or **Esc**.
- **Esc** always works, wherever the keyboard focus is (a tool's own fields
  included) and whether single-key shortcuts are on or not. Order: an open
  dropdown menu (or the View popover) closes first, then the open tool, then a view tool; with
  nothing open, Esc clears the selection. Dialogs close themselves.
- Clicks in the view that are not part of the tool's own work (picking a face,
  an edge, the objects for Intersect) change nothing while an exclusive tool is
  open: no selection change, no closing.
- Ending an exclusive tool (Apply, Cancel or Esc) also stops its calculation,
  so Cancel and Esc are the single cancel path. "Working…" always shows in
  its own box under the tool bar (the bar never changes size for it); inside
  a tool it has no Cancel button of its own.
- With nothing selected and a single object in the drawing, the tools work on
  that object instead of asking to select it first (not Delete or Cut).
- New shapes, bolts, nuts and threads appear at the origin (x = 0, y = 0),
  resting on the plate, even where that overlaps other objects.
- **Enter** reads every field of the open bar first, so the values typed so
  far count even if the field was never left; the preview is worked out again
  if they changed, and Apply follows.
- The Reflection and Plate tiles of the View section open a small popover with
  sliders when switched on (and from the ▾ in the tile while on). It closes on a
  click elsewhere or Esc; that Esc does nothing else (like an open menu).

## What works while an exclusive tool is open

| Action | Allowed | Why |
|---|---|---|
| The tool's own bar, fields, handles and view clicks | Yes | It is the tool |
| Camera (turn, pan, zoom), view cube, Home, Fit, View toggles (X-ray, wireframe, edges, shadows, rulers, reflection, plate) and their sliders | Yes | Only the view changes |
| Side panel open/close, Settings, Export, About, Privacy, keyboard shortcuts panel | Yes | Nothing in the drawing changes |
| Copy (button, Ctrl+C) | Yes | Reads only |
| Measuring tools, Clear measurements | No | Opening another tool would end this one |
| Undo, redo | No | They rebuild the objects the tool works on |
| Cut, paste, delete, duplicate, select all/none/invert, group, ungroup, the object list | No | They change or remove what the tool works on |
| Other toolbar tools and menus (add, combine, edit, mirror, more, check) | No | One tool at a time |
| Arrange (on plate, lay flat, center, align, distribute, pack) | No | They move what the tool works on |
| Transform bar values, reset rotation, proportions lock | No | Same; the Move/Rotate handles stay available where the tool itself uses them |
| New drawing, Import, Reference picture | No | They replace or add to the drawing |
| Select several, Delete (corner buttons) | No | Selection and deleting |

Locked controls are dimmed, don't respond, and their tooltip and a message say
"Finish or cancel the current tool first (Apply or Cancel)". The toolbar
button of the open tool stays highlighted.

With a light tool open, everything works as usual. With a view tool open,
the same as for an exclusive tool is locked (the drawing only shows, it
doesn't change; the Move/Rotate/Size handles are off), except the measuring
tools, which work on the cut.

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
| Subtract | Yes | One step: the selection (whole groups) is cut out of every object it goes into, then removed; objects it doesn't touch stay as they are |
| Intersect | Yes | Clicking a part puts the whole group in the role |
| Check and Repair | Yes | Each part is checked and repaired |
| Colour | Yes | All parts, when the group is selected (a part's colour box in the list recolours just that part otherwise) |
| Bevel, round, brace, shell, text | No | Dimmed; "works on one object at a time": Merge the group first, or Ungroup and pick one part |
| Best print orientation | No | Same: the orientation is worked out for one object |

## Rotate 90°

One tool, in the toolbar when there is room and in the More menu otherwise.
It opens a bar with the buttons X, Y and Z: each click adds a quarter turn
clockwise as seen from the positive end of the axis, shown as an orange preview
(the selection itself is hidden meanwhile) and as a total in the bar's title
("X 90°, Z 180°"). Reset clears the turns. The selection turns as one piece
about its centre (groups and several objects too) and keeps the lowest point at
the same height, so things on the plate stay on it. Apply is one undo step;
Cancel changes nothing. Like the other toolbar items it is locked while a tool
is open, with nothing selected and a single object in the drawing it works on
that object, and R repeats it.

## Mirror

A toolbar button that opens a bar with the mirror mode: Axis (X, Y or Z; X to
start with) or Line (click two points; the mirror is the vertical plane through
them), and an orange preview of the flipped selection. "Keep the original"
(off to start with) leaves the selection as it is and adds the mirrored copies
instead, selected, and copies of a group form a group of their own. Apply is
one undo step; Cancel changes nothing. R repeats it.

## Tools that need two objects

With exactly one visible object in the drawing, Merge, Subtract, Intersect,
Group, Align and Distribute are dimmed, and their tooltip and the message say
"Needs at least two objects in the drawing". Keyboard shortcuts for them go
through the same check.

## Bevel and round

Edges are always picked one by one; there is no "all sharp edges" choice,
since on threads that means tens of thousands of edges. Both tools can be used
on the same object (bevel some edges, round others). Picking the many short
edges a bevel or rounding leaves behind and treating them again works, but is
slow and builds large meshes.