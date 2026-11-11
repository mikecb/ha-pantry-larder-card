---
name: pantry-larder
description: Answer questions about and keep the records of the user's pantry, fridges and freezers through the Simple Inventory integration in Home Assistant, as drawn by the Pantry Larder Card. Use for "do we have X", "where is the X", "what's running low or expiring", "we used / finished / bought X", "put X in the basement freezer", planning a shopping list or a meal from what's on hand, and for changing the card's storage layout. Requires Home Assistant tools that can call actions.
---

# Pantry Larder

The user's food is recorded in Home Assistant by the
[Simple Inventory](https://github.com/blaineventurine/simple_inventory)
integration. The Pantry Larder Card only draws it: a larder list by category,
and every storage place drawn to scale with its contents. Nothing is stored in
the card except the storage layout.

Treat the inventory as the single source of truth. Read it before you answer,
and write back what the user tells you, so the card and later answers agree
with the kitchen.

## How to reach it

Everything is a Home Assistant action in the `simple_inventory` domain. Call
them with your Home Assistant action tool (for example `call_action` with
`action: simple_inventory.get_items`). If an action is refused or missing, say
so; do not guess at what is in the pantry.

First find the inventory: the card's `inventory` option names a sensor
(default `sensor.pantry_inventory`), and that sensor's `inventory_id`
attribute is what the actions take. You can pass `inventory_name` instead.

| Action | Use it to |
| --- | --- |
| `get_items` | Read every item in the inventory (returns a response). **Call this first, every time.** |
| `get_items_from_all_inventories` | Search when the user may keep food in more than one inventory. |
| `increment_item` / `decrement_item` | Add or take away an `amount` of an item, by `name`. |
| `add_item` | Record a new item: `name`, `quantity`, `unit`, `category`, `location`, `expiry_date`. |
| `update_item` | Change an item, found by `old_name`: rename it, move it, re-categorise it, set an exact quantity. |
| `remove_item` | Delete an item the household no longer keeps at all. |
| `get_inventory_consumption_rates` / `get_item_consumption_rates` | How fast things are used, over `window_days`. |
| `lookup_by_barcode` / `scan_barcode` | Find or adjust an item by its barcode. |

## What an item looks like

Each item from `get_items` has `name`, `quantity`, `unit`, `category` and
`categories`, `location` and `locations`, `expiry_date`, `expiry_alert_days`,
`desired_quantity`, `description`, `barcodes` and `aliases`.

- **Locations are names, matched exactly.** They are the same names the
  card's `appliances` use ("Kitchen Pantry 3", "Basement Freezer"). Use the
  names already in the inventory; don't invent a near-miss like
  "Basement freezer" or "Pantry 3", or the item will land under "Elsewhere"
  on the card.
- **An item can be in several places, but has one amount.** Simple Inventory
  keeps a single total per item. If the user says "two jars upstairs and one
  downstairs", record 3 with both locations, and say the split isn't kept.
- **Several locations or categories** are written as a comma-separated list
  in `add_item` and `update_item`.
- **Low stock** means `quantity` is at or below `desired_quantity` (when that
  is set). **Expiring** means `expiry_date` falls within `expiry_alert_days`.

## Recording versus advising

- **Facts the user reports are recorded at once.** "We finished the rice",
  "I bought two dozen eggs", "the soup is in the chest freezer now": write
  it, then confirm in a line with the new amount and place.
- **Prefer increment and decrement** for "used" and "bought": they change the
  amount without touching anything else. Use `update_item` only to set an
  exact count the user gives you, to move or rename something.
- `update_item` takes the item's current name as `old_name`. To be safe, read
  the item first and pass its current `unit`, `category` and `location` back
  unchanged along with the field you are changing.
- **Running out is not deleting.** An item at 0 stays, so it shows as low and
  can go on a shopping list. Use `remove_item` only when the user says they
  no longer keep it at all.
- **Ask before guessing.** If "the cheese" could be three items, or the
  amount or place is unclear, ask. Never decrement on a guess that something
  was probably used.
- **Money is the user's.** Suggest what to buy; never buy.

## Common requests

### "Do we have X?" / "Where is the X?"

`get_items`, then match on `name` and `aliases`, loosely (singular and plural,
"tinned" and "canned"). Answer with the amount, unit and every location, in
one line. If nothing matches, say so and offer to add it.

### "What's running low?" / "What's expiring?" / shopping list

1. `get_items`.
2. List what has expired or expires soon first, by date, with where it is.
3. Then what is at or below `desired_quantity`, then what is at 0.
4. Group by where you'd buy or use it, not by location, and keep it short.
5. For a longer view, `get_inventory_consumption_rates` with `window_days`
   (for example 60) shows what is used fastest, which tells you what to
   stock more of.

### "We used / finished / bought X"

Find the item, then `decrement_item` or `increment_item` with `amount` in the
item's own unit. If the user gives a different unit ("a cup of the flour"
when flour is kept in bags), convert only when it is obvious, otherwise ask.
New things go in with `add_item`; ask where they were put if the user didn't
say, and use an existing category where one fits.

### "What can I make?"

`get_items`, then suggest dishes from what is there, using what expires
soonest first. Say what you would need to buy for each. Don't record anything
until the user says they cooked it, then decrement what was used.

### A routine check

If you are run on a schedule, speak up only when something needs the user:
food that has expired or expires within a few days, and staples at 0. If
nothing needs them, stay quiet.

## Changing the storage layout

The card draws storage from its `appliances` option in the dashboard's card
config, not from the inventory. When the user gets a new freezer or moves
shelves, change the card config (the README has every `kind` and option),
and make sure each part's `loc` is exactly the location name used on the
items. A location used by items but missing from `appliances` still shows,
under "Elsewhere". Ask for measurements in inches; they only set the
drawing's proportions, so an estimate is fine.

## Things to avoid

- Answering from memory when `get_items` has the answer.
- Creating a second item for something that already exists under a slightly
  different name. Search first; offer to add an alias instead.
- Inventing location names, or splitting one item's amount between places.
- Removing an item because it reached 0.
- Changing devices, dashboards or other Home Assistant settings unless the
  user asked for that specific change.
