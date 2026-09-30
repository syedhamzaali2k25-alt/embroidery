# Sample logos

`make_samples.py` draws the test logos and sets the width each one is digitized at (`WIDTHS_MM`):

| Sample | Width | What it tests |
|---|---|---|
| `circle` | 60 mm | fill, speck removal and a filled pinhole |
| `letter_a` | 60 mm | fill with a hole |
| `two_shape` | 60 mm | fill, jumps between separate shapes |
| `bold_r` | 18 mm | satin strokes, a bowl, junctions, a sharp corner |
| `thin_ring` | 40 mm | one closed satin loop |
| `mixed` | 50 mm | wide disc (fill), swoosh and chevron (satin), a lollipop (one shape, wide + narrow, so fill) |
| `junctions` | 50 mm | thin strokes meeting as a T, an X and a Y: satin junctions and their fill patches |
| `two_colour` | 60 mm | two thread colours on white: two layers, one colour change |
| `three_colour` | 60 mm | three colours, two of them touching: the blend along their border must not become a shape |
| `gradient` | 60 mm | a smoothly shaded disc: reduced to at most `colour.max_colours` flat bands |
| `noisy_specks` | 60 mm | a star with dark specks, grain and JPEG artefacts: speck removal and the "many specks" warning |
| `bird` | 90 mm | an original seven-colour bird on a branch (drawn by `make_samples.py`, a stand-in for a customer logo) |

`run_samples.py` writes `out/<name>/out.dst`, `preview.png` and `report.json` (skipped/trimmed rungs, patches, jumps: things the DST format cannot hold). In the preview, every stitch is drawn in its colour layer's colour (the image's own colour), underlay is faded, each satin column has a number in sewing order, and jumps are dashed.

These outputs use `--test-run-values`: the stand-in `TEST_RUN_OVERRIDES` in `config.py`, **not chosen product values**. They exist to check the code. Only sew them as a code check.
