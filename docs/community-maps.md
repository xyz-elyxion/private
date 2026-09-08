# Community Maps

Community maps use a small, versioned JSON document. The format is deliberately
limited to axis-aligned collision boxes so a shared map has the same movement,
spawn, and hit-scan behavior in every browser.

```json
{
  "version": 1,
  "id": "my-map",
  "name": "My Map",
  "bounds": { "min": { "x": -30, "y": -1, "z": -20 }, "max": { "x": 30, "y": 20, "z": 20 } },
  "spawn": { "x": 0, "y": 0.05, "z": 15 },
  "boxes": [
    { "min": { "x": -30, "y": -1, "z": -20 }, "max": { "x": 30, "y": 0, "z": 20 } }
  ]
}
```

Documents are validated before use: ids are lowercase URL-safe strings, bounds
and boxes must be finite and non-degenerate, the spawn must be inside bounds,
and a map may contain at most 256 boxes. `src/game/community-maps.ts` contains
the bundled `Citadel` example.