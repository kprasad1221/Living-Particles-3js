# Headless checks

Python + Playwright scripts that drive the study with a fake clock and software WebGL (SwiftShader), adapted from Audio Geology 3JS. They are evidence for behaviour, not performance: SwiftShader frame times say nothing about a real GPU. Watch **fps** under Controls → Camera · render · scenes in a normal browser for that.

```
cd tools
npm install                        # local three / tweakpane, so the import map resolves offline
pip install playwright pillow && playwright install chromium
python capture.py check            # → captures/check.json
python capture.py                  # av1/av2/av3/nocturne at Stand, AV2 at Survey, AV3 Low
python capture.py av2:survey:clean # look:camera[:clean]  (clean hides the interface)
python capture.py ui               # 1440×900, 820×1180, 390×844
```

`check` runs:

1. **Timing.** Five seconds of the test signal cut into 30, 60 and 120 Hz display frames: the voice history must be identical (the 60 Hz fixed clock).
2. **Onsets.** Hits per voice over 5 s of the polyrhythm test signal.
3. **Counts.** Tiles, draw calls (including the bloom passes), triangles, live sparks.
4. **Scene round trip.** Snapshot → change → apply → identical looks.
5. **Rebuild.** Capacity change and back.

Set `LP_CHROME=/path/to/chrome` for a system Chrome, `LP_OUT` for another output folder.
