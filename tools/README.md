# Checks and captures

Evidence, not performance: the browser runs use software WebGL (SwiftShader), so their frame times say nothing about a real GPU. For that, watch the frame-rate readout in a normal browser (Edit › Inspect › View and performance).

```
cd tools
npm install                              # local three.js, so the import map resolves offline
pip install playwright pillow numpy && playwright install chromium
node fixtures.mjs                        # waveform fixtures (spec §8.1), no browser → captures/fixtures.json
node history.test.mjs                    # what each history channel means (lift, hit, rim, colour, shimmer slot, reset), no browser
python capture.py check                  # integration checks (spec §8.2) → captures/check.json
python capture.py                        # look captures at the same musical moment
python capture.py av2p:stand av2:survey  # look:camera[:clean]
python capture.py diag av2p              # composite / no glow / glow only / emission / surfaces
python capture.py motion av2 av2p        # orbiting-camera clips, side by side
python capture.py phrase                 # matched rest / attack / crest / release on the composed excerpt
python capture.py harmony                # harmony → shimmer off / on and its meters
python capture.py ui                     # Perform and Edit at 1440, 820 and 390 px
python flow.py                           # the first-use path with real clicks and keys at 1440 and 390 px → captures/flow.json
node palette.test.mjs                    # ramps and palette files, no browser (--write regenerates palettes/*.json from the looks)
python sample_palette.py SPEC CLIP --sheet out.jpg   # a palette sampled by region from a reference clip; spec in palettes/sources/ (needs ffmpeg, numpy, Pillow)
python looks_check.py                    # ramps, accent, received light, scene and palette round trips; and the light study sheets
node score.test.mjs                      # the authored score and this world's routes, no browser → captures/score.json
python score_check.py                    # the composed response in the page (9 checks), then sheets, a timing chart and a clip
python score_check.py checks             # only the checks (about a minute); `sheets` renders only the pictures and the clip (about ten)
python capture.py matched baseline       # matched stills for a named set of scenes (SETS in capture.py: baseline, looks)
python compare.py grid DIR_A DIR_B out.jpg --labels before after --set baseline   # pair two folders into one sheet + differences
python phrase_excerpt.py out.wav         # the composed 20 s excerpt on its own (synthetic music)
```

The page runs on a fake display clock and a virtual audio clock (`sources.virtual`), so every capture and check is repeatable. Set `LP_CHROME=/path/to/chrome` for a system Chrome, `LP_OUT` for another output folder, and `LP_REPO=/path/to/checkout` (with another `LP_PORT`) to run these tools against a different checkout, for example an older commit for a before / after sheet.

`history.test.mjs` runs the page's own `src/response.js` under Node; `three-resolve.mjs` maps the bare `three` import to the local copy.
