# Shared modules

Small pieces written so another sketch (Audio Geology, the Stellar Tide Court study) can copy them. Each has no three.js import and reads no app state: everything it needs is passed in.

The boundary they sit on: **source → measured features → interpretation → authored score → world**. These modules cover colour and (from P3) the authored score. Hex layout, camera, materials and control labels stay in the world that owns them.

| Module | Promises | Does not do |
|---|---|---|
| `palette.js` | A palette is plain JSON (`schema`, `id`, `version`, `source`, `inputColorSpace: 'srgb'`, `ramps`). Stops keep their `id` and their order. `bakeStops` interpolates the sRGB-encoded stop colours and returns **linear** rgb; `toSRGB8` re-encodes for an 8-bit sRGB texture that the GPU decodes once. `sanitizePalette` repairs stops and refuses a newer schema or a non-sRGB file with a message. | Decide what a ramp position means, make textures, or choose colours. |

## Copying one into another repo

1. Copy the file as is and keep its header.
2. Note the commit it came from in the new repo (the header has a line for it) and anything you change.
3. Bring its test (`tools/palette.test.mjs`) or the checks that apply.
4. Write the adapter in the new world: what feeds the ramp position, which roles it uses.

Nothing here is a package yet. That comes after a second world has used a module and shown what it needs.
