# Earth–Mars Trajectory Builder

An interactive web app that computes and animates real Earth-to-Mars transfer trajectories from user-supplied dates. Enter a departure date and Mars arrival date (and optionally an Earth return date for a free-return trajectory), and the app solves the actual orbital mechanics — not a lookup table.

**Live demo:** https://orbital-trajectories.vercel.app

## Physics

- **Ephemeris:** JPL low-precision Keplerian elements (Standish 1992), valid 1800–2050. Positions computed analytically; velocities via 1-hour central finite difference.
- **Lambert solver:** Universal-variable formulation — scans z ∈ (−4π², 4π²) to bracket the time-of-flight root, then bisects to 1e-12 convergence. Single-revolution, prograde transfers only.
- **Kepler propagator:** Universal-variable propagator (Newton's method on the Kepler time equation) — satisfies Kepler's second law exactly; no curve fitting.
- **Hyperbolic flyby (free-return):** Full 3-D hyperbolic arc geometry. Periapsis direction is the bisector of the incoming/outgoing asymptotes; SOI crossing times computed from the hyperbolic time equation. Includes trim-burn ΔV where the two Lambert legs imply different v∞ magnitudes.

**Validation:** propagating each leg for its full time-of-flight should land within meters of the target ephemeris position. Errors and a hyperbola-direction alignment check are shown in the Validation panel.

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
index.html   — page layout and form
style.css    — dark space-theme UI
physics.js   — all orbital mechanics (ephemeris, Lambert, Kepler propagator, flyby)
app.js       — canvas rendering, animation loop, info panel
```

## Building for production

No build required. The app is vanilla HTML/CSS/JS with zero dependencies. To deploy, copy the four files to any static host.
