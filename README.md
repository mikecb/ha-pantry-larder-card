# Pantry Larder Card

A Lovelace card that shows a [Simple Inventory](https://github.com/blaineventurine/simple_inventory) pantry as a printed larder list, in the same style as the cellar wine list card.

- Larder list tab: items grouped by category, with amount, unit, notes and storage locations.
- By location tab: each storage place drawn to scale (cabinets, French-door fridge, side-by-side fridge, upright freezer, room), with its contents by category.
- Item dialog: amount with plus and minus buttons, and every location the item is in.

```yaml
type: custom:pantry-larder-card
title: The Pantry
inventory: sensor.pantry_inventory
```

Status: personal use. The storage layout is currently the built-in `DEFAULT_APPLIANCES`; making it configurable is the next step before publishing to HACS. Fonts load from the cellar card's `cellar-fonts.js` (Cormorant Garamond, SIL Open Font License).
