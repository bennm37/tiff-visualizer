[← Documentation index](./index.md)

# Export and interchange

## Export…

The **Export…** command (`Ctrl`/`Cmd` + `S` while a viewer tab has focus) writes
the current view, image or layer stack. Targets:

| Format | What it writes |
| --- | --- |
| **Current view (PNG)** | What is on screen: the visible part of the image with its cells, transcripts, ROIs and scale bar. The first entry, and the default |
| **PNG** | The whole rendered image as displayed — normalization, gamma, brightness and colormap baked in |
| **OpenRaster (.ora)** | Layer stack, open standard, opens in Krita and GIMP |
| **GIMP 3 XCF (.xcf)** | Layer stack for GIMP 3 |
| **Krita (.kra)** | Layer stack for Krita |
| **Photoshop (.psd)** | Layer stack for Photoshop and compatible tools |

The distinction to keep straight: **PNG export is display output**, 8-bit, with
your view settings applied — it is what you paste into a paper or a slide. The
layered formats preserve the stack structure so you can keep editing elsewhere.
Neither is a way to write scientific data back out; this extension is a viewer,
not a converter.

Export correctness is referenced against the synchronous CPU compositing path,
so an exported composite matches the CPU render regardless of which GPU backend
was driving your screen.

## Current view

**Current view (PNG)** exports the part of the image you are looking at, cut to
the window: pan and zoom to a region, then export it. It works in the image
viewer and in the Xenium viewer, where it includes the cell outlines and
transcripts on screen.

After you choose it, a short list asks what to include. Cells, transcripts and
ROIs, and the scale bar, are ticked; untick either to leave it out. **Double
resolution (2×)** writes twice the screen pixels, which makes outlines, text and
the scale bar sharper for a figure. The picture itself is not re-read at a finer
level, so image pixels are enlarged rather than more detailed.

The viewer's own controls (readouts, the histogram, panels) and the selection
and hover highlights on ROIs are not part of the export. In the Xenium viewer
the export waits for the tiles of the current view to arrive, so it is not a
blurred preview.

The standalone web viewer downloads the same PNG when you press `Ctrl`/`Cmd` +
`S` or choose **Export current view**.

## Copy View

**Copy View** (`Ctrl`/`Cmd` + `C`) puts the same picture on the clipboard, with
the cells, ROIs and scale bar as shown. It also remembers where the view is, so
**Paste Position** on another image, or in another tab, puts that image at the
same place and zoom. Copy a view of one image, switch to a second image of the
same scene and paste, to compare the two at the same spot.

## Copy Image

**Copy Image** (`Ctrl`/`Cmd` + `Shift` + `C`) puts the whole image on the
clipboard at its own resolution, without the view, the overlays or the scale
bar, ready to paste into a document, chat or issue. Same rule as PNG export:
what you see is what you get, including the current display settings. It does
not change the position that Paste Position uses.

### Shortcuts that VS Code also uses

`Ctrl`/`Cmd` + `S` is VS Code's Save and `Ctrl`/`Cmd` + `Shift` + `C` opens a
new terminal window in VS Code by default. These viewers have nothing to save, and the shortcuts apply only
while a viewer tab has focus, so they take precedence there and nowhere else. To
use different keys, rebind **Export…** or **Copy Image** in Keyboard Shortcuts
(`Ctrl`/`Cmd` + `K`, `Ctrl`/`Cmd` + `S`).

## Copy Image Information

`Ctrl`/`Cmd` + `Shift` + `I` copies a text summary — dimensions, format, bit
depth, channels, statistics. Pair it with a screenshot when reporting anything;
it saves a round trip of questions.

The metadata panel's copy button does the fuller version: all metadata and
statistics as JSON.

## Measurement results

Covered in detail in [measurement](./measure.md): tidy CSV with provenance,
German-locale CSV, real `.xlsx`, a generated pandas script, and standalone CSV
export for line profiles.

ROIs themselves live in a JSON sidecar next to the image and interchange with
ImageJ `.roi` and `RoiSet.zip`.

## Point clouds

**Open as Point Cloud** sends the currently selected single-channel image plane
as an NPY file to the **3D Point Cloud and Mesh Visualizer** extension
(`kleinicke.ply-visualizer`), which must be installed separately. It uses the
selected array, slice or frame and the decoded sample values, without display
normalization, gamma or colormaps. Any source format exposing a scalar decoded
plane can use this handoff; it is not limited to the 3D viewer's depth formats.

RGB images, channel composites, layer blends, unavailable original samples and
in-progress loads are rejected. Samples are written as float64 to preserve their
existing decoded precision, at the decoded plane's resolution. Camera intrinsics,
pose and matching RGB are not transferred; the 3D viewer retains its usual
camera-parameter workflow.

The intermediate file is kept in the extension's cache while the 3D tab is open
and removed when that tab closes in the same session. Files retained across an
editor shutdown remain available for restoring the tab. Invoking the command
with a file outside the active image preview retains the original format-specific
handoff.

## Paste Position

**Paste Position** applies the position saved by the last **Copy View**: the
same place in the image, at the same zoom, scaled to the size of the image you
paste it into. It works across tabs, so it is how you compare two images, or two
people compare notes, at the same location.
