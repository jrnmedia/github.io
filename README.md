# Glitch Simulator

A web page that simulates video and digital glitches in real time, in plain HTML, CSS and JavaScript with no build step and no dependencies.

## Effects

- **RGB split**: red and blue channels drift apart (chromatic aberration).
- **Slice shift**: horizontal bands tear sideways.
- **VHS tracking**: wobbling lines, a noisy tracking band rolling down the picture, head-switching noise along the bottom edge and vertical-hold jumps.
- **Block corruption**: macroblocks that are displaced, mis-coloured, flattened to one colour, or bleeding downward.
- **Datamosh smear**: blocks keep dragging the previous frame instead of updating.
- **Pixel sort**: runs of pixels inside a band are sorted by brightness.
- **Bit crush**: colour depth drops.
- **Static noise**: grain, static lines and snow.
- **Scanlines**: a CRT line overlay.

Between bursts every effect idles at a low level. Bursts arrive at random (set with **Burst rate**) or on demand. Presets include Signal loss, VHS, Broken stream, Pixel sort, Meltdown and Clean.

## Sources

- **Text**: your own headline on a synthwave title card.
- **Test card**: SMPTE-style colour bars.
- **Image**: choose a file, drag one onto the screen or paste one from the clipboard.
- **Camera**: your webcam, mirrored. The browser asks for permission first.

Images and camera frames are processed locally and never leave the device.

## Controls

| Key | Action |
| --- | --- |
| `G` / `Space` (hold) | Glitch burst. Holding the screen or the Glitch button does the same. |
| `P` | Pause / play. While paused, each glitch draws a new still. |
| `R` | Randomize all effects. |
| `S` | Save the current frame as PNG. |
| `O` | Toggle the on-screen display. |

**Record 5s** saves a short WebM (or MP4 in Safari) clip where the browser supports `MediaRecorder`.

When the system asks for reduced motion, the page starts paused on a still frame and explains why.

## Running locally

Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000
```

The camera only works over HTTPS or on `localhost`.
