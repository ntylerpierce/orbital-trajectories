'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const MU_SUN    = 1.32712440018e11;  // km³/s²
const MU_MARS   = 42828.37;          // km³/s²
const R_MARS    = 3389.5;            // km
const R_SOI_MARS= 577186.8;          // km
const AU_KM     = 1.495978707e8;     // km per AU
const DEG       = Math.PI / 180;

// ─── Date / JD conversion ─────────────────────────────────────────────────────
function dateToJD(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const A = Math.floor((14 - m) / 12);
    const Y = y + 4800 - A;
    const M = m + 12 * A - 3;
    return d + Math.floor((153*M + 2)/5) + 365*Y
         + Math.floor(Y/4) - Math.floor(Y/100) + Math.floor(Y/400) - 32045;
}

function jdToDateStr(jd) {
    const l  = Math.floor(jd) + 68569;
    const n  = Math.floor(4 * l / 146097);
    const l2 = l - Math.floor((146097*n + 3)/4);
    const i  = Math.floor(4000*(l2 + 1)/1461001);
    const l3 = l2 - Math.floor(1461*i/4) + 31;
    const j  = Math.floor(80*l3/2447);
    const day   = l3 - Math.floor(2447*j/80);
    const l4    = Math.floor(j/11);
    const month = j + 2 - 12*l4;
    const year  = 100*(n - 49) + i + l4;
    return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function jdToDate(jd) {
    // Returns JS Date object (midnight UTC for that calendar day)
    const str = jdToDateStr(jd);
    return new Date(str + 'T12:00:00Z');
}

// ─── Keplerian elements (Standish 1992, Table 1, valid 1800–2050) ────────────
const ELEMENTS = {
    earth: {
        a:     [1.00000261,    0.00000562],
        e:     [0.01671123,   -0.00004392],
        I:     [-0.00001531,  -0.01294668],
        L:     [100.46457166, 35999.37244981],
        peri:  [102.93768193,  0.32327364],
        Omega: [0.0,           0.0]
    },
    mars: {
        a:     [1.52371034,   0.00001847],
        e:     [0.09339410,   0.00007882],
        I:     [1.84969142,  -0.00813131],
        L:     [-4.55343205, 19140.30268499],
        peri:  [-23.94362959, 0.44441088],
        Omega: [49.55953891, -0.29257343]
    }
};

function wrapDeg180(x) {
    x = ((x % 360) + 360) % 360;
    if (x > 180) x -= 360;
    return x;
}

function keplerElements(body, JD) {
    const T  = (JD - 2451545.0) / 36525.0;
    const el = ELEMENTS[body];
    return {
        a:     el.a[0]     + el.a[1]     * T,
        e:     el.e[0]     + el.e[1]     * T,
        I:     el.I[0]     + el.I[1]     * T,
        L:     el.L[0]     + el.L[1]     * T,
        peri:  el.peri[0]  + el.peri[1]  * T,
        Omega: el.Omega[0] + el.Omega[1] * T
    };
}

// Newton's method for Kepler's equation M = E - e·sin(E) (radians)
function solveKepler(M_rad, e) {
    let E = M_rad + e * Math.sin(M_rad);
    for (let i = 0; i < 100; i++) {
        const dE = (M_rad - E + e * Math.sin(E)) / (1 - e * Math.cos(E));
        E += dE;
        if (Math.abs(dE) < 1e-12) break;
    }
    return E;
}

// Heliocentric ecliptic Cartesian position in km
function getEclipticPos(body, JD) {
    const { a, e, I, L, peri, Omega } = keplerElements(body, JD);
    const omega  = (peri - Omega) * DEG;
    const OmegaR = Omega * DEG;
    const IR     = I * DEG;
    const M      = wrapDeg180(L - peri) * DEG;
    const E      = solveKepler(M, e);

    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(Math.max(0, 1 - e*e)) * Math.sin(E);

    const cw = Math.cos(omega), sw = Math.sin(omega);
    const cO = Math.cos(OmegaR), sO = Math.sin(OmegaR);
    const cI = Math.cos(IR),     sI = Math.sin(IR);

    const x = (cw*cO - sw*sO*cI)*xp + (-sw*cO - cw*sO*cI)*yp;
    const y = (cw*sO + sw*cO*cI)*xp + (-sw*sO + cw*cO*cI)*yp;
    const z = (sw*sI)*xp             + (cw*sI)*yp;

    return [x * AU_KM, y * AU_KM, z * AU_KM];
}

// State vector via central finite difference
function getStateVector(body, JD) {
    const h  = 1/24;  // 1 hour in days
    const rm = getEclipticPos(body, JD - h);
    const rp = getEclipticPos(body, JD + h);
    const r  = getEclipticPos(body, JD);
    const dt = 2 * h * 86400;
    return {
        r,
        v: [(rp[0]-rm[0])/dt, (rp[1]-rm[1])/dt, (rp[2]-rm[2])/dt]
    };
}

// ─── Stumpff functions ────────────────────────────────────────────────────────
function stumpffC(z) {
    if (z >  1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
    if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / (-z);
    return 0.5 - z/24 + z*z/720;
}

function stumpffS(z) {
    if (z > 1e-6) {
        const sq = Math.sqrt(z);
        return (sq - Math.sin(sq)) / (sq * sq * sq);
    }
    if (z < -1e-6) {
        const sq = Math.sqrt(-z);
        return (Math.sinh(sq) - sq) / (sq * sq * sq);
    }
    return 1/6 - z/120 + z*z/5040;
}

// ─── Lambert solver (universal variable, prograde, single-rev) ───────────────
// r1_vec, r2_vec in km; tof in seconds
// Returns { v1, v2, z } or null if no solution
function lambertSolve(r1_vec, r2_vec, tof) {
    const r1 = vecMag(r1_vec);
    const r2 = vecMag(r2_vec);

    const dot12   = vecDot(r1_vec, r2_vec);
    const cross_z = r1_vec[0]*r2_vec[1] - r1_vec[1]*r2_vec[0];

    let dnu = Math.acos(Math.max(-1, Math.min(1, dot12 / (r1 * r2))));
    if (cross_z < 0) dnu = 2*Math.PI - dnu;

    // Degenerate cases
    if (dnu < 1e-8 || Math.abs(dnu - Math.PI) < 1e-8) return null;

    const A = Math.sin(dnu) * Math.sqrt(r1 * r2 / (1 - Math.cos(dnu)));

    function y_fn(z) {
        const C = stumpffC(z), S = stumpffS(z);
        if (C < 1e-15) return NaN;
        return r1 + r2 + A * (z*S - 1) / Math.sqrt(C);
    }

    function t_fn(z) {
        const C = stumpffC(z), S = stumpffS(z);
        const y = y_fn(z);
        if (!isFinite(y) || (A > 0 && y < 0)) return NaN;
        return ((y/C)**1.5 * S + A * Math.sqrt(y)) / Math.sqrt(MU_SUN);
    }

    // Scan for bracket
    const z_lo = -4*Math.PI*Math.PI;
    const z_hi =  4*Math.PI*Math.PI;
    const N = 300;
    let za = null, zb = null, ta = null;

    for (let i = 0; i <= N; i++) {
        const z = z_lo + (z_hi - z_lo) * i / N;
        const t = t_fn(z);
        if (!isFinite(t) || isNaN(t)) { ta = null; continue; }
        if (ta !== null && (ta - tof) * (t - tof) <= 0) {
            za = z_lo + (z_hi - z_lo) * (i-1) / N;
            zb = z;
            break;
        }
        ta = t;
    }
    if (za === null) return null;

    // Bisection
    for (let i = 0; i < 80; i++) {
        const zm = (za + zb) / 2;
        const tm = t_fn(zm);
        if (isNaN(tm)) { za = zm; continue; }
        if ((t_fn(za) - tof) * (tm - tof) <= 0) zb = zm;
        else                                      za = zm;
        if (Math.abs(zb - za) < 1e-12) break;
    }

    const z  = (za + zb) / 2;
    const y  = y_fn(z);
    if (!isFinite(y) || y <= 0) return null;

    const f    = 1 - y / r1;
    const g    = A * Math.sqrt(y / MU_SUN);
    const gdot = 1 - y / r2;

    if (Math.abs(g) < 1e-12) return null;

    const v1 = r2_vec.map((r2i, k) => (r2i - f*r1_vec[k]) / g);
    const v2 = r2_vec.map((r2i, k) => (gdot*r2i - r1_vec[k]) / g);

    return { v1, v2, z };
}

// ─── Universal-variable Kepler propagator ─────────────────────────────────────
// r0_vec (km), v0_vec (km/s), dt (s) → { r, v }
function keplerPropagate(r0_vec, v0_vec, dt) {
    if (Math.abs(dt) < 1e-6) return { r: [...r0_vec], v: [...v0_vec] };

    const r0  = vecMag(r0_vec);
    const v0  = vecMag(v0_vec);
    const vr0 = vecDot(r0_vec, v0_vec) / r0;
    const alpha = 2/r0 - v0*v0/MU_SUN;  // 1/a for ellipse

    // Initial guess for universal variable chi
    let chi = Math.sqrt(MU_SUN) * Math.abs(alpha) * dt;
    if (Math.abs(alpha) < 1e-10) chi = Math.sqrt(MU_SUN) * dt / r0;

    const sqrtMu = Math.sqrt(MU_SUN);
    for (let iter = 0; iter < 60; iter++) {
        const z  = alpha * chi * chi;
        const C  = stumpffC(z);
        const S  = stumpffS(z);
        const F  = (r0*vr0/sqrtMu)*chi*chi*C
                 + (1 - alpha*r0)*chi*chi*chi*S
                 + r0*chi - sqrtMu*dt;
        const dF = (r0*vr0/sqrtMu)*chi*(1 - alpha*chi*chi*S)
                 + (1 - alpha*r0)*chi*chi*C + r0;
        if (Math.abs(dF) < 1e-20) break;
        const dchi = F / dF;
        chi -= dchi;
        if (Math.abs(dchi) < 1e-10) break;
    }

    const z    = alpha * chi * chi;
    const C    = stumpffC(z), S = stumpffS(z);
    const f    = 1 - (chi*chi/r0)*C;
    const g    = dt - (1/sqrtMu)*chi*chi*chi*S;
    const r_vec = r0_vec.map((x,k) => f*x + g*v0_vec[k]);
    const rn = vecMag(r_vec);

    const fdot = sqrtMu/(rn*r0) * (alpha*chi*chi*chi*S - chi);
    const gdot = 1 - (chi*chi/rn)*C;
    const v_vec = r0_vec.map((x,k) => fdot*x + gdot*v0_vec[k]);

    return { r: r_vec, v: v_vec };
}

// ─── Orbit elements from state vector ─────────────────────────────────────────
function orbitElements(r_vec, v_vec) {
    const r   = vecMag(r_vec);
    const v2  = vecDot(v_vec, v_vec);
    const rdv = vecDot(r_vec, v_vec);
    const a   = 1 / (2/r - v2/MU_SUN);

    const h_vec = vecCross(r_vec, v_vec);
    const h     = vecMag(h_vec);
    const eps   = v2/2 - MU_SUN/r;

    const e_vec = [
        (v2/MU_SUN - 1/r)*r_vec[0] - rdv/MU_SUN*v_vec[0],
        (v2/MU_SUN - 1/r)*r_vec[1] - rdv/MU_SUN*v_vec[1],
        (v2/MU_SUN - 1/r)*r_vec[2] - rdv/MU_SUN*v_vec[2]
    ];
    const e = vecMag(e_vec);

    return { a, e, eps, h };
}

// ─── Hyperbolic flyby (free-return) ──────────────────────────────────────────
// v_inf_in_vec, v_inf_out_vec: spacecraft v_inf relative to Mars (km/s)
function computeFlyby(v_inf_in_vec, v_inf_out_vec) {
    const mag_in  = vecMag(v_inf_in_vec);
    const mag_out = vecMag(v_inf_out_vec);
    const u_in    = vecScale(v_inf_in_vec, 1/mag_in);
    const u_out   = vecScale(v_inf_out_vec, 1/mag_out);

    const dotUU = Math.max(-1, Math.min(1, vecDot(u_in, u_out)));
    const delta = Math.acos(dotUU);   // turn angle

    const e_hyp   = 1 / Math.sin(delta / 2);
    const r_p     = MU_MARS * (e_hyp - 1) / (mag_in * mag_in);
    const altitude= r_p - R_MARS;
    const dv_trim = Math.abs(mag_out - mag_in);

    // SOI crossing duration (hyperbolic time-of-flight from periapsis to SOI)
    const a_hyp  = r_p / (1 - e_hyp);       // < 0 for hyperbola
    const n_h    = Math.sqrt(MU_MARS / ((-a_hyp)**3));

    // Solve r(nu_soi) = R_SOI_MARS : nu_soi = acos((p/R_SOI - 1)/e_hyp)
    const p = r_p * (1 + e_hyp);
    const cos_nu_soi = (p/R_SOI_MARS - 1) / e_hyp;
    const nu_soi = Math.acos(Math.max(-1, Math.min(1, cos_nu_soi)));

    // nu_to_time
    function nu2t(nu) {
        const fac = Math.sqrt((e_hyp - 1)/(e_hyp + 1));
        const H   = 2 * Math.atanh(fac * Math.tan(nu/2));
        const M   = e_hyp * Math.sinh(H) - H;
        return M / n_h;
    }

    const t_soi = nu2t(nu_soi);   // seconds from periapsis to SOI crossing

    return { e_hyp, r_p, altitude, delta, mag_in, mag_out, dv_trim,
             a_hyp, n_h, p, nu_soi, t_soi,
             u_in, u_out };
}

// Build the 3-D hyperbolic arc (Mars-centered, km)
// Returns array of [x,y,z] points
function buildHyperbolicArc(flyby, nPts = 120) {
    const { e_hyp, r_p, p, nu_soi, u_in, u_out } = flyby;

    // Periapsis direction bisects the two asymptote directions: e1 = normalize(u_in + u_out)
    // u_in - u_out lies in the e2 direction (determines sign)
    const e1 = vecNorm(vecAdd(u_in, u_out));
    const n_raw = vecCross(u_in, u_out);
    if (vecMag(n_raw) < 1e-10) return [];
    const n    = vecNorm(n_raw);
    const e2t  = vecNorm(vecCross(n, e1));
    // Choose sign of e2 so that u_in = (1/e1)*e1 + sin(nu_inf)*e2 (positive e2 component)
    const mirror = vecDot(vecSub(u_in, u_out), e2t) > 0 ? 1 : -1;
    const e2   = vecScale(e2t, mirror);

    function to3D(x2, y2) {
        return [e1[0]*x2 + e2[0]*y2, e1[1]*x2 + e2[1]*y2, e1[2]*x2 + e2[2]*y2];
    }

    const nu_start = -nu_soi * 0.9998;
    const nu_end   =  nu_soi * 0.9998;
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
        const nu = nu_start + (nu_end - nu_start) * i / nPts;
        const r  = p / (1 + e_hyp * Math.cos(nu));
        pts.push(to3D(r * Math.cos(nu), r * Math.sin(nu)));
    }
    return pts;
}

// ─── Orbit ring (one period of planet positions) ──────────────────────────────
function getOrbitRing(body, refJD, nPts = 200) {
    const periods = { earth: 365.25, mars: 686.97 };
    const P = periods[body];
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
        pts.push(getEclipticPos(body, refJD + P * i / nPts));
    }
    return pts;
}

// ─── Arc propagation (for animation path) ─────────────────────────────────────
function propagateArc(r0, v0, tof_sec, nPts = 120) {
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
        const dt = tof_sec * i / nPts;
        pts.push(keplerPropagate(r0, v0, dt).r);
    }
    return pts;
}

// ─── Vector math helpers ──────────────────────────────────────────────────────
function vecMag(v)       { return Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2); }
function vecDot(a, b)    { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function vecCross(a, b)  { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function vecScale(v, s)  { return [v[0]*s, v[1]*s, v[2]*s]; }
function vecSub(a, b)    { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vecAdd(a, b)    { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function vecNorm(v)      { const m = vecMag(v); return m > 0 ? vecScale(v, 1/m) : [0,0,0]; }
function vecMagSq(v)     { return v[0]**2 + v[1]**2 + v[2]**2; }

// ─── Main trajectory computation ─────────────────────────────────────────────
// Returns trajectory object or { error: string }
function computeTrajectory(params) {
    const { departureStr, arrivalStr, returnStr, mode } = params;

    const jd_dep = dateToJD(departureStr);
    const jd_arr = dateToJD(arrivalStr);
    const jd_ret = returnStr ? dateToJD(returnStr) : null;

    // Date range validation
    const jd_min = dateToJD('1800-01-01');
    const jd_max = dateToJD('2050-12-31');
    for (const jd of [jd_dep, jd_arr, ...(jd_ret ? [jd_ret] : [])]) {
        if (jd < jd_min || jd > jd_max)
            return { error: 'Dates must be within the 1800–2050 ephemeris validity window.' };
    }
    if (jd_arr <= jd_dep)
        return { error: 'Mars arrival date must be after Earth departure date.' };
    if (mode === 'freereturn') {
        if (!jd_ret) return { error: 'Free-return mode requires an Earth return date.' };
        if (jd_ret <= jd_arr) return { error: 'Earth return date must be after Mars arrival date.' };
    }

    const tof_out = (jd_arr - jd_dep) * 86400;  // seconds
    const tof_ret = jd_ret ? (jd_ret - jd_arr) * 86400 : null;

    // Warn on very short TOFs
    const warnings = [];
    if (tof_out < 60 * 86400)
        warnings.push('Outbound TOF < 60 days — Lambert solution may not exist.');
    if (tof_ret && tof_ret < 60 * 86400)
        warnings.push('Return TOF < 60 days — Lambert solution may not exist.');

    // Ephemeris
    const earth_dep = getStateVector('earth', jd_dep);
    const mars_arr  = getStateVector('mars',  jd_arr);

    // Outbound Lambert
    const lambert_out = lambertSolve(earth_dep.r, mars_arr.r, tof_out);
    if (!lambert_out)
        return { error: 'No single-revolution transfer exists for these departure and arrival dates. Try dates further apart or closer to a launch window.' };

    const v_sc_dep = lambert_out.v1;   // spacecraft velocity at departure (km/s)
    const v_sc_arr = lambert_out.v2;   // spacecraft velocity at Mars arrival

    // C3 and departure excess
    const dv_dep_vec = vecSub(v_sc_dep, earth_dep.v);
    const c3_dep     = vecMagSq(dv_dep_vec);
    const c3_check   = c3_dep >= 0 && isFinite(c3_dep);

    // Outbound orbit elements
    const out_orbit = orbitElements(earth_dep.r, v_sc_dep);

    // Sweep angle (angle from r_dep to r_arr)
    const sweep = Math.acos(Math.max(-1, Math.min(1,
        vecDot(vecNorm(earth_dep.r), vecNorm(mars_arr.r))
    ))) / DEG;

    // Outbound arc points for animation
    const arc_out = propagateArc(earth_dep.r, v_sc_dep, tof_out);

    // Validation: propagate full TOF and compare to Mars ephemeris
    const prop_end_out = keplerPropagate(earth_dep.r, v_sc_dep, tof_out);
    const err_out_km   = vecMag(vecSub(prop_end_out.r, mars_arr.r));

    // Warn on high C3 or long TOF
    if (c3_dep > 100) warnings.push(`High C3 (${c3_dep.toFixed(1)} km²/s²) — energetically expensive trajectory.`);
    if (tof_out > 500 * 86400) warnings.push(`Long transfer (${(tof_out/86400).toFixed(0)} days) — slow trajectory.`);

    const result = {
        mode,
        jd_dep, jd_arr, jd_ret,
        tof_out_days: tof_out / 86400,
        earth_dep, mars_arr,
        v_sc_dep, v_sc_arr,
        c3_dep,
        out_orbit,
        sweep_deg: sweep,
        arc_out,
        warnings,
        validation: { err_out_km, c3_valid: c3_check }
    };

    if (mode !== 'freereturn') return result;

    // ── Free-return leg ──────────────────────────────────────────────────────
    const earth_ret  = getStateVector('earth', jd_ret);
    const lambert_ret= lambertSolve(mars_arr.r, earth_ret.r, tof_ret);
    if (!lambert_ret)
        return { error: 'No single-revolution return transfer exists for the Mars flyby and Earth return dates. Try different dates.' };

    const v_sc_dep2 = lambert_ret.v1;  // spacecraft leaving Mars for return
    const v_sc_arr2 = lambert_ret.v2;  // spacecraft arriving Earth

    // v_inf vectors relative to Mars
    const v_inf_in  = vecSub(v_sc_arr,  mars_arr.v);  // incoming relative to Mars
    const v_inf_out = vecSub(v_sc_dep2, mars_arr.v);  // outgoing relative to Mars

    const flyby = computeFlyby(v_inf_in, v_inf_out);

    // Flyby validation
    if (flyby.altitude < 150) {
        return { error: `This combination would require passing ${flyby.altitude < 0 ? 'below Mars\'s surface' : `only ${flyby.altitude.toFixed(0)} km above Mars (below safe 150 km minimum)`} — try different dates.` };
    }
    if (flyby.altitude > 50000) {
        warnings.push(`Flyby altitude ${Math.round(flyby.altitude).toLocaleString()} km — very distant, weak gravity-assist effect.`);
    }

    // Build hyperbolic arc
    const hyp_arc = buildHyperbolicArc(flyby);

    // Return leg elements
    const ret_orbit = orbitElements(mars_arr.r, v_sc_dep2);
    const arc_ret   = propagateArc(mars_arr.r, v_sc_dep2, tof_ret);

    // Validation: return leg propagation error
    const prop_end_ret = keplerPropagate(mars_arr.r, v_sc_dep2, tof_ret);
    const err_ret_km   = vecMag(vecSub(prop_end_ret.r, earth_ret.r));

    // Hyperbola direction check: arc endpoints should align with u_in / u_out
    let hyp_dir_check = 0;
    if (hyp_arc.length >= 2) {
        const dir_in  = vecNorm(vecSub(hyp_arc[1], hyp_arc[0]));
        const dir_out = vecNorm(vecSub(hyp_arc[hyp_arc.length-1], hyp_arc[hyp_arc.length-2]));
        hyp_dir_check = (vecDot(dir_in, flyby.u_in) + vecDot(dir_out, flyby.u_out)) / 2;
    }

    result.flyby      = flyby;
    result.hyp_arc    = hyp_arc;
    result.v_inf_in   = v_inf_in;
    result.v_inf_out  = v_inf_out;
    result.v_sc_dep2  = v_sc_dep2;
    result.v_sc_arr2  = v_sc_arr2;
    result.earth_ret  = earth_ret;
    result.tof_ret_days = tof_ret / 86400;
    result.ret_orbit  = ret_orbit;
    result.arc_ret    = arc_ret;
    result.validation.err_ret_km   = err_ret_km;
    result.validation.hyp_dir_check = hyp_dir_check;

    return result;
}
