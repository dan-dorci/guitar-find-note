# Find That Note

Guitar ear-training web app: hear a note, find it on the fretboard — including
telling apart the *same pitch* played at different positions (e.g. open high e
vs. D string fret 14) by timbre alone.

Modes: Explore (free play), Find the Pitch, Exact Spot, Unison Duel.

Sounds are per-(string, fret) recordings of a Fender Stratocaster sliced from
the [IDMT-SMT-Guitar dataset](https://zenodo.org/record/7544110)
(Kehling et al., Fraunhofer IDMT, CC BY-NC-ND 4.0 — personal/evaluation use
only, not for commercial use or redistribution). Positions without a sample
fall back to Karplus-Strong synthesis (`app.js`). `tools/extract_samples.py`
regenerates `samples/` from the dataset.

Run locally: `python3 -m http.server 8117` in this directory, then open
http://localhost:8117.
