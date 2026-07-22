# Find That Note

Guitar ear-training web app: hear a note, find it on the fretboard — including
telling apart the *same pitch* played at different positions (e.g. open high e
vs. D string fret 14) by timbre alone.

Modes: Explore (free play), Find the Pitch, Exact Spot, Unison Duel.

## Audio credits and license

The per-(string, fret) note recordings in `samples/` are excerpts of a Fender
Stratocaster from the [IDMT-SMT-Guitar dataset](https://zenodo.org/record/7544110)
by Christian Kehling et al., Fraunhofer IDMT, licensed under
[CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/).
Changes made: individual notes were excerpted verbatim at the note boundaries
given by the dataset's annotations, loudness-normalized with a short fade-out
at the cut points, and format-converted from WAV to AAC (`tools/extract_samples.py`
reproduces this from the original dataset). The excerpts are shared here
non-commercially with attribution; no creative modification was made. This
project makes no commercial use of the material.

Positions without a sample fall back to Karplus-Strong synthesis (`app.js`).

Run locally: `python3 -m http.server 8117` in this directory, then open
http://localhost:8117.
