# Earth–Mars Trajectory Builder

An interactive web app that computes and animates real Earth-to-Mars transfer trajectories from user-supplied dates. Enter a departure date and Mars arrival date (and optionally an Earth return date for a free-return trajectory), or pick one of 14 real mission opportunities from the preset dropdown — the app solves the actual orbital mechanics either way, not a lookup table.

**Live demo:** https://orbital-trajectories.vercel.app

## Features

- **Custom trajectories** — pick any Earth departure date and Mars arrival date; the app solves Lambert's problem for the actual transfer orbit connecting them.
- **Free-return mode** — add an Earth return date to get a full Earth→Mars→Earth trajectory, including a real hyperbolic gravity-assist arc around Mars (not an instantaneous direction change).
- **Preset mission opportunities** — a dropdown above the Compute & Animate button pre-fills the date fields with 14 real free-return trajectories spanning four actual Earth-Mars launch windows (2028–30, 2031–32, 2033–34, 2035–36), each labeled with its mission duration and total ΔV. Picking a preset just populates the same date fields the manual inputs use, so it stays editable afterward — and reverts to "Custom dates" if you edit a field by hand.
- **Validation panel** — reports the propagation error against the target ephemeris position for each leg, and the hyperbola direction-alignment check for the flyby.

## Physics

- **Ephemeris:** JPL low-precision Keplerian elements (Standish 1992), valid 1800–2050. Positions computed analytically; velocities via 1-hour central finite difference.
- **Lambert solver:** Universal-variable formulation — scans z ∈ (−4π², 4π²) to bracket the time-of-flight root, then bisects to 1e-12 convergence. Single-revolution, prograde transfers only.
- **Kepler propagator:** Universal-variable propagator (Newton's method on the Kepler time equation) — satisfies Kepler's second law exactly; no curve fitting.
- **Hyperbolic flyby (free-return):** Full 3-D hyperbolic arc geometry. Periapsis direction is the bisector of the incoming/outgoing asymptotes; SOI crossing times computed from the hyperbolic time equation. Includes trim-burn ΔV where the two Lambert legs imply different v∞ magnitudes.
- **Preset data:** the 14 built-in trajectories are real mission-design output (departure/flyby/return dates, duration, C3, and total ΔV) — the same dates are re-solved through the Lambert/Kepler pipeline above rather than replayed from a stored path, so they're subject to the same validation as any custom date entry.

**Validation:** propagating each leg for its full time-of-flight should land within meters of the target ephemeris position. Errors and the hyperbola-direction alignment check are shown in the Validation panel.

## Running locally

No build step — open `index.html` directly in any modern browser.

```
# Just open the file:
open index.html          # macOS
start index.html         # Windows
xdg-open index.html      # Linux
```

Or serve it with any static server if you prefer:

```bash
npx serve .
# then visit http://localhost:3000
```

## Project structure

```
index.html   — page layout and form (including the preset dropdown)
style.css    — dark space-theme UI
physics.js   — all orbital mechanics (ephemeris, Lambert, Kepler propagator, flyby)
app.js       — canvas rendering, animation loop, info panel, preset trajectory data
```

## Building for production

No build required. The app is vanilla HTML/CSS/JS with zero dependencies. To deploy, copy the four files to any static host.
