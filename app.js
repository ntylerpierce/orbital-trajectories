'use strict';

// ─── Colour palette ───────────────────────────────────────────────────────────
const CLR = {
    sun:        '#ffe066',
    earth:      '#4fc3f7',
    mars:       '#ef7c4e',
    earthOrbit: '#1a3a5c',
    marsOrbit:  '#3d1f10',
    outbound:   '#7ec8e3',
    returnArc:  '#ff8c69',
    flyby:      '#c084fc',
    sc:         '#ffffff',
    trail:      'rgba(255,255,255,0.55)',
};

// ─── App state ────────────────────────────────────────────────────────────────
let traj       = null;   // computed trajectory
let playing    = false;
let animProg   = 0;      // 0..1
let lastTime   = null;
let animSpeed  = 1/30;   // progress per second at 1× (full mission in 30s)
let rafId      = null;
let trailPts   = [];
let ringEarth  = null;   // cached orbit ring points
let ringMars   = null;

const CANVAS_SIZE    = 620;
const FLYBY_SIZE     = 260;
const MAX_VISIBLE_AU = 2.05;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
let mainCanvas, mainCtx, flybyCanvas, flybyCtx;
let playBtn, scrubber, timeDisplay;
let infoPanel, messagesDiv, debugContent;

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
    mainCanvas  = document.getElementById('main-canvas');
    flybyCanvas = document.getElementById('flyby-canvas');
    mainCtx     = mainCanvas.getContext('2d');
    flybyCtx    = flybyCanvas.getContext('2d');
    mainCanvas.width  = mainCanvas.height  = CANVAS_SIZE;
    flybyCanvas.width = flybyCanvas.height = FLYBY_SIZE;

    playBtn     = document.getElementById('play-pause');
    scrubber    = document.getElementById('scrubber');
    timeDisplay = document.getElementById('time-display');
    infoPanel   = document.getElementById('info-panel');
    messagesDiv = document.getElementById('messages');
    debugContent= document.getElementById('debug-content');

    // Mode toggle
    document.getElementById('mission-mode').addEventListener('change', onModeChange);
    onModeChange();

    // Altitude radio
    document.querySelectorAll('input[name="altitude-mode"]').forEach(r =>
        r.addEventListener('change', () => {
            const manual = document.getElementById('altitude-manual');
            manual.classList.toggle('hidden', r.value !== 'manual' || !r.checked);
        })
    );

    document.getElementById('traj-form').addEventListener('submit', onSubmit);
    playBtn.addEventListener('click', togglePlay);
    scrubber.addEventListener('input', onScrub);

    drawIdleCanvas();

    // Default dates: a realistic 2026 launch window
    document.getElementById('dep-date').value  = '2026-11-26';
    document.getElementById('arr-date').value  = '2027-08-01';
    document.getElementById('ret-date').value  = '2028-03-15';
});

function onModeChange() {
    const mode = document.getElementById('mission-mode').value;
    document.getElementById('return-section').classList.toggle('hidden', mode !== 'freereturn');
}

// ─── Form submit ──────────────────────────────────────────────────────────────
function onSubmit(e) {
    e.preventDefault();
    messagesDiv.innerHTML = '';

    const dep  = document.getElementById('dep-date').value;
    const arr  = document.getElementById('arr-date').value;
    const ret  = document.getElementById('ret-date').value;
    const mode = document.getElementById('mission-mode').value;

    if (!dep || !arr) { showError('Please fill in departure and arrival dates.'); return; }
    if (mode === 'freereturn' && !ret) {
        showError('Please fill in the Earth return date for free-return mode.');
        return;
    }

    let result;
    try {
        result = computeTrajectory({ departureStr: dep, arrivalStr: arr,
                                     returnStr: mode === 'freereturn' ? ret : null, mode });
    } catch (err) {
        showError('Internal error: ' + err.message);
        return;
    }

    if (result.error) { showError(result.error); return; }

    traj = result;

    // Warnings
    for (const w of traj.warnings || []) {
        const d = document.createElement('div');
        d.className = 'msg-warn';
        d.textContent = '⚠ ' + w;
        messagesDiv.appendChild(d);
    }

    // Pre-compute orbit rings (expensive — do once, not per frame)
    ringEarth = getOrbitRing('earth', traj.jd_dep, 220);
    ringMars  = getOrbitRing('mars',  traj.jd_dep, 220);

    // Reset animation
    playing   = false;
    animProg  = 0;
    trailPts  = [];
    playBtn.textContent = '▶';
    scrubber.value = 0;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

    populateInfo();
    populateDebug();
    updateFlybyWrap();
    drawFrame(0);
    startAnimation();
}

function showError(msg) {
    messagesDiv.innerHTML = `<div class="msg-error">✖ ${msg}</div>`;
}

// ─── Animation ────────────────────────────────────────────────────────────────
function startAnimation() {
    playing   = true;
    lastTime  = null;
    playBtn.textContent = '⏸';
    animProg  = 0;
    trailPts  = [];
    rafId = requestAnimationFrame(animLoop);
}

function togglePlay() {
    if (!traj) return;
    playing = !playing;
    playBtn.textContent = playing ? '⏸' : '▶';
    if (playing) {
        lastTime = null;
        rafId = requestAnimationFrame(animLoop);
    }
}

function onScrub() {
    if (!traj) return;
    animProg = Number(scrubber.value) / 1000;
    trailPts = [];  // clear trail on manual scrub
    drawFrame(animProg);
}

function animLoop(ts) {
    if (!playing) return;
    if (lastTime === null) lastTime = ts;
    const dt = (ts - lastTime) / 1000;
    lastTime = ts;
    animProg = Math.min(1, animProg + dt * animSpeed);
    scrubber.value = Math.round(animProg * 1000);
    drawFrame(animProg);
    if (animProg >= 1) {
        playing = false;
        playBtn.textContent = '▶';
        return;
    }
    rafId = requestAnimationFrame(animLoop);
}

// ─── Canvas coordinate helpers ────────────────────────────────────────────────
// km → canvas pixel (origin at canvas centre, y flipped)
function toCanvas(x_km, y_km, cx, cy, scale) {
    return [cx + x_km * scale, cy - y_km * scale];
}

function mainScale() {
    return (CANVAS_SIZE / 2 - 20) / (MAX_VISIBLE_AU * AU_KM);
}

// ─── Drawing ──────────────────────────────────────────────────────────────────
function drawIdleCanvas() {
    const ctx = mainCtx;
    const W = CANVAS_SIZE, H = CANVAS_SIZE;
    ctx.fillStyle = '#090b12';
    ctx.fillRect(0, 0, W, H);
    // Faint star field
    drawStars(ctx, W, H, 120);
    // Placeholder rings (approximate circles)
    const cx = W/2, cy = H/2, sc = mainScale();
    ctx.strokeStyle = CLR.earthOrbit; ctx.lineWidth = 1; ctx.globalAlpha = 0.4;
    drawCircle(ctx, cx, cy, 1.0 * AU_KM * sc);
    ctx.strokeStyle = CLR.marsOrbit;
    drawCircle(ctx, cx, cy, 1.52 * AU_KM * sc);
    ctx.globalAlpha = 1;
    // Sun
    drawSun(ctx, cx, cy);
    drawLegend(ctx, W, H);
}

let starField = null;
function drawStars(ctx, W, H, n) {
    if (!starField) {
        starField = [];
        for (let i = 0; i < n; i++) {
            starField.push([Math.random()*W, Math.random()*H, Math.random()*1.2 + 0.3]);
        }
    }
    ctx.fillStyle = '#ffffff';
    for (const [x, y, r] of starField) {
        ctx.globalAlpha = 0.3 + Math.random() * 0.2;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI*2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function drawCircle(ctx, cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.stroke();
}

function drawSun(ctx, cx, cy) {
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 18);
    g.addColorStop(0, '#fffde7');
    g.addColorStop(0.4, '#ffe066');
    g.addColorStop(1, 'rgba(255,200,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = CLR.sun;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI*2);
    ctx.fill();
}

function drawLegend(ctx, W, H) {
    const items = [
        { c: CLR.earth,    label: 'Earth' },
        { c: CLR.mars,     label: 'Mars' },
        { c: CLR.outbound, label: 'Outbound arc' },
        { c: CLR.returnArc,label: 'Return arc' },
        { c: CLR.flyby,    label: 'Flyby' },
    ];
    let x = 12, y = H - 24;
    ctx.font = '11px Segoe UI, sans-serif';
    for (const it of items) {
        ctx.fillStyle = it.c;
        ctx.beginPath();
        ctx.arc(x+4, y+1, 4, 0, Math.PI*2);
        ctx.fill();
        ctx.fillStyle = 'rgba(180,190,210,0.7)';
        ctx.fillText(it.label, x+12, y+5);
        x += ctx.measureText(it.label).width + 28;
    }
}

function drawOrbitRing(ctx, pts, cx, cy, sc, color) {
    if (pts.length < 2) return;
    ctx.beginPath();
    const [x0, y0] = toCanvas(pts[0][0], pts[0][1], cx, cy, sc);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
        const [x, y] = toCanvas(pts[i][0], pts[i][1], cx, cy, sc);
        ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawArc(ctx, pts, cx, cy, sc, color, lineWidth, maxFrac) {
    const end = Math.max(1, Math.floor(pts.length * maxFrac));
    ctx.beginPath();
    const [x0, y0] = toCanvas(pts[0][0], pts[0][1], cx, cy, sc);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < end; i++) {
        const [x, y] = toCanvas(pts[i][0], pts[i][1], cx, cy, sc);
        ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
}

function drawPlanet(ctx, pos, cx, cy, sc, color, radius, label) {
    const [px, py] = toCanvas(pos[0], pos[1], cx, cy, sc);
    // Glow
    const g = ctx.createRadialGradient(px, py, 1, px, py, radius*3);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, radius*3, 0, Math.PI*2);
    ctx.fill();
    // Body
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI*2);
    ctx.fill();
    // Label
    ctx.fillStyle = 'rgba(200,210,230,0.85)';
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.fillText(label, px + radius + 3, py - 3);
}

function drawSpacecraft(ctx, pos, cx, cy, sc) {
    const [px, py] = toCanvas(pos[0], pos[1], cx, cy, sc);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI*2);
    ctx.fill();
}

function drawTrail(ctx, pts, cx, cy, sc) {
    if (pts.length < 2) return;
    ctx.beginPath();
    const [x0, y0] = toCanvas(pts[0][0], pts[0][1], cx, cy, sc);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
        const [x, y] = toCanvas(pts[i][0], pts[i][1], cx, cy, sc);
        ctx.lineTo(x, y);
    }
    ctx.strokeStyle = CLR.trail;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;
}

// ─── Main draw frame ──────────────────────────────────────────────────────────
function drawFrame(prog) {
    const ctx = mainCtx;
    const W = CANVAS_SIZE, H = CANVAS_SIZE;
    const cx = W/2, cy = H/2;
    const sc = mainScale();

    ctx.fillStyle = '#090b12';
    ctx.fillRect(0, 0, W, H);
    drawStars(ctx, W, H, 120);

    if (!traj) { drawIdleCanvas(); return; }

    const t = traj;

    // Orbit rings (pre-computed on trajectory submission)
    ctx.globalAlpha = 0.35;
    drawOrbitRing(ctx, ringEarth, cx, cy, sc, CLR.earthOrbit);
    drawOrbitRing(ctx, ringMars,  cx, cy, sc, CLR.marsOrbit);
    ctx.globalAlpha = 1;

    // Sun
    drawSun(ctx, cx, cy);

    // ── Determine spacecraft position from prog ──
    let scPos, currentJD, phase;
    const totalDays = t.mode === 'freereturn'
        ? t.tof_out_days + t.tof_ret_days
        : t.tof_out_days;
    const flybyFrac = t.mode === 'freereturn'
        ? t.tof_out_days / totalDays : null;

    const FLYBY_WIDTH = 0.05;   // 5% of anim timeline is the flyby phase

    if (t.mode === 'oneway') {
        // Simple: prog maps linearly to outbound TOF
        phase     = 'out';
        currentJD = t.jd_dep + prog * t.tof_out_days;
        const dt  = prog * t.tof_out_days * 86400;
        scPos     = keplerPropagate(t.earth_dep.r, t.v_sc_dep, dt).r;
    } else {
        // Free-return: three phases with a widened flyby window
        // outPhase: 0 → (flybyFrac - FLYBY_WIDTH/2) of anim → 0..1 of outbound
        // flyPhase: (flybyFrac - FLYBY_WIDTH/2) → (flybyFrac + FLYBY_WIDTH/2) → 0..1 of flyby
        // retPhase: (flybyFrac + FLYBY_WIDTH/2) → 1 of anim → 0..1 of return
        const pb  = flybyFrac * (1 - FLYBY_WIDTH);  // boundary before flyby
        const pa  = pb + FLYBY_WIDTH;               // boundary after flyby

        if (prog <= pb) {
            phase     = 'out';
            const f   = prog / pb;
            currentJD = t.jd_dep + f * t.tof_out_days;
            const dt  = f * t.tof_out_days * 86400;
            scPos     = keplerPropagate(t.earth_dep.r, t.v_sc_dep, dt).r;
        } else if (prog <= pa) {
            phase     = 'flyby';
            const f   = (prog - pb) / FLYBY_WIDTH;  // 0..1 within flyby
            // Map f to hyperbolic arc index
            const arcIdx = Math.floor(f * (t.hyp_arc.length - 1));
            const marsPos = t.mars_arr.r;
            const pt  = t.hyp_arc[Math.min(arcIdx, t.hyp_arc.length - 1)];
            scPos     = vecAdd(marsPos, pt);
            currentJD = t.jd_arr + (f - 0.5) * (2 * t.flyby.t_soi / 86400);
        } else {
            phase     = 'ret';
            const f   = (prog - pa) / (1 - pa);
            currentJD = t.jd_arr + f * t.tof_ret_days;
            const dt  = f * t.tof_ret_days * 86400;
            scPos     = keplerPropagate(t.mars_arr.r, t.v_sc_dep2, dt).r;
        }
    }

    // Planet positions at currentJD
    const earthPos = getEclipticPos('earth', currentJD);
    const marsPos  = getEclipticPos('mars',  currentJD);

    // Trail
    trailPts.push([...scPos]);
    if (trailPts.length > 200) trailPts.shift();

    // Draw complete arcs (faded)
    ctx.setLineDash([4, 4]);
    drawArc(ctx, t.arc_out, cx, cy, sc, CLR.outbound, 1.2, 1.0);
    if (t.mode === 'freereturn') {
        drawArc(ctx, t.arc_ret, cx, cy, sc, CLR.returnArc, 1.2, 1.0);
    }
    ctx.setLineDash([]);

    // Draw trail
    drawTrail(ctx, trailPts, cx, cy, sc);

    // Draw partial arcs up to current position (solid)
    if (phase === 'out' || phase === 'flyby' || phase === 'ret') {
        const outFrac = phase === 'out' ? prog / (flybyFrac ? flybyFrac*(1-FLYBY_WIDTH) : 1)
                      : 1.0;
        drawArc(ctx, t.arc_out, cx, cy, sc, CLR.outbound, 2.2, outFrac);
    }
    if (t.mode === 'freereturn' && (phase === 'ret')) {
        const retFrac = (prog - (flybyFrac*(1-FLYBY_WIDTH)+FLYBY_WIDTH)) / (1 - (flybyFrac*(1-FLYBY_WIDTH)+FLYBY_WIDTH));
        drawArc(ctx, t.arc_ret, cx, cy, sc, CLR.returnArc, 2.2, Math.max(0, retFrac));
    }

    // Planets
    drawPlanet(ctx, earthPos, cx, cy, sc, CLR.earth, 5, 'Earth');
    drawPlanet(ctx, marsPos,  cx, cy, sc, CLR.mars,  4.5, 'Mars');

    // Spacecraft
    drawSpacecraft(ctx, scPos, cx, cy, sc);

    // Legend + date
    drawLegend(ctx, W, H);
    ctx.fillStyle = 'rgba(160,170,200,0.7)';
    ctx.font = '12px Segoe UI, sans-serif';
    ctx.fillText(jdToDateStr(currentJD), W - 110, 20);

    // Update time display
    timeDisplay.textContent = jdToDateStr(currentJD);

    // Flyby inset
    if (t.mode === 'freereturn') {
        const flybyProgInPhase = phase === 'flyby'
            ? (prog - (flybyFrac*(1-FLYBY_WIDTH))) / FLYBY_WIDTH
            : (phase === 'ret' ? 1 : 0);
        drawFlybyInset(flybyProgInPhase);
    }
}

// ─── Flyby inset canvas ───────────────────────────────────────────────────────
function drawFlybyInset(prog) {
    const ctx = flybyCtx;
    const W = FLYBY_SIZE, H = FLYBY_SIZE;
    const cx = W/2, cy = H/2;

    ctx.fillStyle = '#06080f';
    ctx.fillRect(0, 0, W, H);

    if (!traj || traj.mode !== 'freereturn' || !traj.hyp_arc || traj.hyp_arc.length < 2) return;

    // Scale: show ±1.5 * SOI
    const sc = (W/2 - 15) / (R_SOI_MARS * 1.1);

    // SOI circle
    ctx.strokeStyle = 'rgba(100,120,180,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    drawCircle(ctx, cx, cy, R_SOI_MARS * sc);
    ctx.setLineDash([]);

    // Mars
    const mR = 14;
    const mg = ctx.createRadialGradient(cx, cy, 1, cx, cy, mR*2);
    mg.addColorStop(0, '#ef7c4e');
    mg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = mg;
    ctx.beginPath();
    ctx.arc(cx, cy, mR*2, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = CLR.mars;
    ctx.beginPath();
    ctx.arc(cx, cy, mR, 0, Math.PI*2);
    ctx.fill();

    // Hyperbolic arc
    const arc = traj.hyp_arc;
    if (arc.length >= 2) {
        ctx.beginPath();
        const [x0, y0] = toCanvas(arc[0][0], arc[0][1], cx, cy, sc);
        ctx.moveTo(x0, y0);
        for (let i = 1; i < arc.length; i++) {
            const [x, y] = toCanvas(arc[i][0], arc[i][1], cx, cy, sc);
            ctx.lineTo(x, y);
        }
        ctx.strokeStyle = CLR.flyby;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Spacecraft position on flyby arc
        const idx = Math.floor(prog * (arc.length - 1));
        const pt  = arc[Math.max(0, Math.min(arc.length-1, idx))];
        const [spx, spy] = toCanvas(pt[0], pt[1], cx, cy, sc);
        ctx.fillStyle = CLR.sc;
        ctx.beginPath();
        ctx.arc(spx, spy, 3, 0, Math.PI*2);
        ctx.fill();

        // Draw arc up to current position
        if (idx > 0) {
            ctx.beginPath();
            const [x0a, y0a] = toCanvas(arc[0][0], arc[0][1], cx, cy, sc);
            ctx.moveTo(x0a, y0a);
            for (let i = 1; i <= idx; i++) {
                const [x, y] = toCanvas(arc[i][0], arc[i][1], cx, cy, sc);
                ctx.lineTo(x, y);
            }
            ctx.strokeStyle = CLR.flyby;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }

    // Periapsis direction marker (will appear near/inside Mars circle at this scale)
    const flyby = traj.flyby;
    const bisect = vecNorm(vecAdd(flyby.u_in, flyby.u_out));
    const [bpx, bpy] = toCanvas(bisect[0]*flyby.r_p, bisect[1]*flyby.r_p, cx, cy, sc);
    ctx.fillStyle = '#a0f0a0';
    ctx.beginPath();
    ctx.arc(bpx, bpy, 3, 0, Math.PI*2);
    ctx.fill();

    // Labels
    ctx.font = '10px Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(120,140,180,0.8)';
    ctx.fillText('SOI', cx + R_SOI_MARS*sc - 24, cy - 4);
    ctx.fillStyle = '#a0f0a0';
    ctx.fillText(`r_p: ${(flyby.altitude+R_MARS).toFixed(0)} km`, 6, H-8);
    ctx.fillStyle = CLR.flyby;
    ctx.fillText(`alt: ${flyby.altitude.toFixed(0)} km`, 6, H-20);
}

// ─── Info panel ───────────────────────────────────────────────────────────────
function populateInfo() {
    if (!traj) return;
    const t = traj;
    const totalDays = t.mode === 'freereturn' ? t.tof_out_days + t.tof_ret_days : t.tof_out_days;

    let html = '';

    // Timeline
    html += section('Timeline', [
        ['Departure', jdToDateStr(t.jd_dep)],
        ['Mars encounter', jdToDateStr(t.jd_arr)],
        ...(t.mode === 'freereturn' ? [['Earth return', jdToDateStr(t.jd_ret)]] : []),
        ['Outbound TOF', `${t.tof_out_days.toFixed(1)} days`],
        ...(t.mode === 'freereturn' ? [['Return TOF', `${t.tof_ret_days.toFixed(1)} days`]] : []),
        ['Total duration', `${totalDays.toFixed(0)} days (${(totalDays/365.25).toFixed(2)} yr)`],
    ]);

    // Outbound orbit
    const a_out = t.out_orbit.a;
    const e_out = t.out_orbit.e;
    const c3str = t.c3_dep.toFixed(2);
    const c3cls = t.c3_dep < 20 ? 'good' : t.c3_dep > 60 ? 'warn' : '';
    html += section('Outbound Transfer (Earth → Mars)', [
        ['Semi-major axis', `${(a_out/AU_KM).toFixed(4)} AU`],
        ['Eccentricity', e_out.toFixed(4)],
        [`C₃ at departure`, `<span class="info-value ${c3cls}">${c3str} km²/s²</span>`],
        ['Departure Δv', `${Math.sqrt(Math.max(0, t.c3_dep)).toFixed(3)} km/s`],
        ['Sweep angle', `${t.sweep_deg.toFixed(1)}°`],
    ]);

    // Free-return extra
    if (t.mode === 'freereturn' && t.flyby) {
        const fly = t.flyby;
        const altCls = fly.altitude < 500 ? 'warn' : fly.altitude > 50000 ? 'note' : 'good';
        html += section('Mars Flyby', [
            ['Periapsis altitude', `<span class="info-value ${altCls}">${fly.altitude.toFixed(0)} km</span>`],
            ['Periapsis radius', `${fly.r_p.toFixed(0)} km`],
            ['Hyperbolic turn angle', `${(fly.delta / DEG).toFixed(2)}°`],
            ['Eccentricity (hyp.)', `${fly.e_hyp.toFixed(4)}`],
            ['v∞ inbound', `${fly.mag_in.toFixed(3)} km/s`],
            ['v∞ outbound', `${fly.mag_out.toFixed(3)} km/s`],
            ['Trim burn Δv', `${(fly.dv_trim*1000).toFixed(1)} m/s`],
            ['SOI crossing duration', `${(2*fly.t_soi/3600).toFixed(1)} hrs`],
        ]);

        const a_ret = t.ret_orbit.a;
        const e_ret = t.ret_orbit.e;
        html += section('Return Transfer (Mars → Earth)', [
            ['Semi-major axis', `${(a_ret/AU_KM).toFixed(4)} AU`],
            ['Eccentricity', e_ret.toFixed(4)],
        ]);
    }

    infoPanel.innerHTML = html;
    infoPanel.classList.remove('hidden');
}

function section(title, rows) {
    let h = `<div class="info-section"><h3>${title}</h3>`;
    for (const [label, val] of rows) {
        const isHtml = val.includes('<');
        h += `<div class="info-row"><span class="info-label">${label}</span>`;
        if (isHtml) h += val;
        else        h += `<span class="info-value">${val}</span>`;
        h += `</div>`;
    }
    h += `</div>`;
    return h;
}

// ─── Debug / validation panel ─────────────────────────────────────────────────
function populateDebug() {
    if (!traj) return;
    const v = traj.validation;
    const erOut = v.err_out_km;

    function okFail(val, isOk) {
        const cls = isOk ? 'ok' : 'fail';
        return `<span class="debug-value ${cls}">${val}</span>`;
    }

    let html = `
    <div class="debug-row">
        <span class="debug-label">Outbound propagation error</span>
        ${okFail(`${erOut < 0.01 ? erOut.toExponential(2) : erOut.toFixed(3)} km`, erOut < 1)}
    </div>
    <div class="debug-row">
        <span class="debug-label">C₃ valid (positive, finite)</span>
        ${okFail(v.c3_valid ? 'YES' : 'NO', v.c3_valid)}
    </div>`;

    if (traj.mode === 'freereturn' && v.err_ret_km !== undefined) {
        const erRet = v.err_ret_km;
        html += `
    <div class="debug-row">
        <span class="debug-label">Return propagation error</span>
        ${okFail(`${erRet < 0.01 ? erRet.toExponential(2) : erRet.toFixed(3)} km`, erRet < 1)}
    </div>
    <div class="debug-row">
        <span class="debug-label">Arc endpoint alignment (avg dot)</span>
        ${okFail(`${v.hyp_dir_check !== undefined ? v.hyp_dir_check.toFixed(6) : 'N/A'}`,
                 v.hyp_dir_check !== undefined && v.hyp_dir_check > 0.999)}
    </div>`;
    }

    debugContent.innerHTML = html;
}

// ─── Flyby inset wrapper show/hide ────────────────────────────────────────────
function updateFlybyWrap() {
    const wrap = document.getElementById('flyby-wrap');
    if (!wrap) return;
    if (traj && traj.mode === 'freereturn' && traj.hyp_arc && traj.hyp_arc.length > 0) {
        wrap.classList.remove('hidden');
        drawFlybyInset(0);
    } else {
        wrap.classList.add('hidden');
    }
}
