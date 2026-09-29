# Sample logos

`make_samples.py` draws the test logos and sets the width each one is digitized at (`WIDTHS_MM`):

| Sample | Width | What it tests |
|---|---|---|
| `circle` | 60 mm | fill, speck and pinhole cleaning |
| `letter_a` | 60 mm | fill with a hole |
| `two_shape` | 60 mm | fill, jumps between separate shapes |
| `bold_r` | 18 mm | satin strokes, a bowl, junctions, a sharp corner |
| `thin_ring` | 40 mm | one closed satin loop |
| `mixed` | 50 mm | wide disc (fill), swoosh and chevron (satin), a lollipop (one shape, wide + narrow, so fill) |

`run_samples.py` writes `out/<name>/out.dst` and `preview.png`. In the preview, each satin column has its own colour and a number in sewing order. Underlay is faded, fill and travel stitches are ink, and jumps are dashed.

These outputs use `--test-run-values`: the stand-in `TEST_RUN_OVERRIDES` in `config.py`, **not chosen product values**. They exist to check the code. Only sew them as a code check.
