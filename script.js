let canvas, ctx, previewCanvas, previewCtx;

let points = [];
let selectedPoint = null;
let isDragging = false;
let deleteMode = false; // Mobile-friendly deletion toggle
let touchStartPos = null; // Store touch start position for touchend

// Settings
let showCurve = true;
let curveResolution = 100; // Number of segments per curve section

// Machining parameters
const machineSettings = {
    unit: 'mm', // 'mm' or 'inch'
    scaleFactor: 0.1, // pixels to real units
    safeHeight: 5.0, // Z safe height
    cutDepth: -1.0, // Z cutting depth (negative)
    feedRate: 300, // Feed rate for G1
    rapidRate: 1000, // Feed rate for G0
    angleMode: '-180-180', // '0-360' or '-180-180'
    angleOffset: 0, // C-axis offset in degrees
    shortestPath: true, // Use shortest rotation path
    toolOffsetX: 0, // Tool tip X offset from origin
    toolOffsetY: 0, // Tool tip Y offset from origin (default 0mm)
};

// Preview state
const preview = {
    segments: [], // {x1,y1,x2,y2,len,cumStart,cumEnd,angle}
    totalLength: 0,
    playing: false,
    speedPxPerSec: 200,
    currentDist: 0, // distance along path
    lastTs: null,
    showDirection: true,
    mode: 'base', // 'base' or 'oriented'
    gcodeLoaded: false,
};

// ============================================
// Event Listeners (Editor Canvas)
// ============================================

function getCanvasPosFromEvent(e) {
    if (!canvas) return { x: 0, y: 0 }; // Return default if canvas not initialized
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }
    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
    };
}

// Event listeners will be set up after DOM is loaded
function setupCanvasEventListeners() {
    if (!canvas) return;
    
    canvas.addEventListener("mousedown", (e) => {
        const { x, y } = getCanvasPosFromEvent(e);
        selectedPoint = getPointAt(x, y);
        isDragging = selectedPoint !== null;
    });

canvas.addEventListener("mousemove", (e) => {
    if (isDragging && selectedPoint !== null) {
        const { x, y } = getCanvasPosFromEvent(e);
        points[selectedPoint].x = x;
        points[selectedPoint].y = y;
        rebuildPreviewPathPreserveProgress();
        draw();
    }
});

canvas.addEventListener("mouseup", () => {
    isDragging = false;
    selectedPoint = null;
});

canvas.addEventListener("click", (e) => {
    if (isDragging) return; // Ignore click if we were dragging
    const { x, y } = getCanvasPosFromEvent(e);
    const idx = getPointAt(x, y);
    if (deleteMode && idx !== null) {
        points.splice(idx, 1);
        rebuildPreviewPathPreserveProgress();
        draw();
        updatePointCount();
        return;
    }
    if (idx === null) {
        points.push({ x, y });
        rebuildPreviewPathPreserveProgress();
        draw();
        updatePointCount();
    }
});

canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const { x, y } = getCanvasPosFromEvent(e);
    const pointIndex = getPointAt(x, y);
    if (pointIndex !== null) {
        points.splice(pointIndex, 1);
        rebuildPreviewPathPreserveProgress();
        draw();
        updatePointCount();
    }
});

// Touch support
canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    console.log('touchstart event', e.touches.length);
    const { x, y } = getCanvasPosFromEvent(e);
    console.log('touchstart pos:', x, y);
    touchStartPos = { x, y }; // Save touch start position
    selectedPoint = getPointAt(x, y);
    if (selectedPoint !== null) isDragging = true;
    console.log('selectedPoint:', selectedPoint, 'isDragging:', isDragging);
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (isDragging && selectedPoint !== null) {
        const { x, y } = getCanvasPosFromEvent(e);
        touchStartPos = { x, y }; // Update position during drag
        points[selectedPoint].x = x;
        points[selectedPoint].y = y;
        rebuildPreviewPathPreserveProgress();
        draw();
    }
}, { passive: false });

canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    console.log('touchend: isDragging=', isDragging, 'touchStartPos=', touchStartPos);
    if (!isDragging && touchStartPos) {
        // Use saved touch position since e.touches is empty on touchend
        const { x, y } = touchStartPos;
        const idx = getPointAt(x, y);
        console.log('touchend: adding point at', x, y, 'idx=', idx);
        if (deleteMode && idx !== null) {
            points.splice(idx, 1);
            rebuildPreviewPathPreserveProgress();
            draw();
            updatePointCount();
        } else if (idx === null) {
            console.log('Adding new point');
            points.push({ x, y });
            rebuildPreviewPathPreserveProgress();
            draw();
            updatePointCount();
        }
    }
    isDragging = false;
    selectedPoint = null;
    touchStartPos = null;
}, { passive: false });
}


// ============================================
// Helper Functions
// ============================================

function getPointAt(x, y, radius = 8) {
    // Larger hit radius on mobile for easier tapping
    const isMobile = window.innerWidth <= 768;
    const hitRadius = isMobile ? 20 : radius;
    
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const dist = Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2);
        if (dist < hitRadius) {
            return i;
        }
    }
    return null;
}

// ============================================
// Catmull-Rom Spline Implementation
// ============================================

function catmullRomSpline(p0, p1, p2, p3, t) {
    // Catmull-Rom spline formula
    const t2 = t * t;
    const t3 = t2 * t;
    
    const x = 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
    );
    
    const y = 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
    );
    
    return { x, y };
}

function drawCurve() {
    if (points.length < 2) return;
    
    ctx.strokeStyle = "#00aaff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    if (points.length === 2) {
        // Just draw a straight line for 2 points
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
    } else {
        // Draw Catmull-Rom spline
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[Math.max(0, i - 1)];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = points[Math.min(points.length - 1, i + 2)];
            
            for (let t = 0; t <= 1; t += 1 / curveResolution) {
                const pt = catmullRomSpline(p0, p1, p2, p3, t);
                
                if (i === 0 && t === 0) {
                    ctx.moveTo(pt.x, pt.y);
                } else {
                    ctx.lineTo(pt.x, pt.y);
                }
            }
        }
    }
    
    ctx.stroke();
}

// ============================================
// Drawing Function
// ============================================

function draw() {
    if (!canvas || !ctx) return; // Skip if canvas not initialized
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw grid (optional)
    drawGrid();
    
    // Draw curve
    if (showCurve && points.length >= 2) {
        drawCurve();
    }
    
    // Draw connection lines (light)
    if (points.length >= 2) {
        ctx.strokeStyle = "#cccccc";
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }
    
    // Draw points
    points.forEach((p, index) => {
        // Larger points on mobile for easier visibility and tapping
        const isMobile = window.innerWidth <= 768;
        const pointRadius = isMobile ? 10 : 6;
        const strokeWidth = isMobile ? 3 : 2;
        
        ctx.fillStyle = "#ff6600";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = strokeWidth;
        
        ctx.beginPath();
        ctx.arc(p.x, p.y, pointRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        
        // Draw point number
        ctx.fillStyle = "#000000";
        ctx.font = isMobile ? "bold 14px Arial" : "10px Arial";
        ctx.fillText(index + 1, p.x + (isMobile ? 14 : 10), p.y - (isMobile ? 14 : 10));
    });

    // Editor only: no preview overlay here anymore
}

function drawGrid() {
    const gridSize = 50;
    ctx.strokeStyle = "#f0f0f0";
    ctx.lineWidth = 1;
    
    // Vertical lines
    for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    
    // Horizontal lines
    for (let y = 0; y < canvas.height; y += gridSize) {
           ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
}

// ============================================
// Preview Drawing (separate canvas)
// ============================================

function drawPreviewGrid() {
    const gridSize = 50;
    previewCtx.strokeStyle = "#f0f0f0";
    previewCtx.lineWidth = 1;
    for (let x = 0; x < previewCanvas.width; x += gridSize) {
        previewCtx.beginPath();
        previewCtx.moveTo(x, 0);
        previewCtx.lineTo(x, previewCanvas.height);
        previewCtx.stroke();
    }
    for (let y = 0; y < previewCanvas.height; y += gridSize) {
        previewCtx.beginPath();
        previewCtx.moveTo(0, y);
        previewCtx.lineTo(previewCanvas.width, y);
        previewCtx.stroke();
    }
}

function drawPreviewPath() {
    if (preview.segments.length === 0) return;
    previewCtx.strokeStyle = "#00aaff";
    previewCtx.lineWidth = 2;
    previewCtx.beginPath();
    const first = preview.segments[0];
    previewCtx.moveTo(first.x1, first.y1);
    for (const seg of preview.segments) {
        previewCtx.lineTo(seg.x2, seg.y2);
    }
    previewCtx.stroke();
}

function drawPreview() {
    if (!previewCanvas || !previewCtx) return;
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    drawPreviewGrid();
    drawPreviewPath();
    drawPreviewOverlay();
}

// ============================================
// UI Control Functions
// ============================================

function toggleDrawMode() {
    const panel = document.getElementById('drawModePanel');
    const btn = document.getElementById('drawModeBtn');
    const editorContainer = document.getElementById('editorCanvasContainer');
    if (panel && btn) {
        const isHidden = panel.style.display === 'none' || panel.style.display === '';
        panel.style.display = isHidden ? 'block' : 'none';
        btn.textContent = isHidden ? '✏️ Hide Drawing Tools' : '✏️ Draw Path Manually';
        if (editorContainer) {
            editorContainer.style.display = isHidden ? 'block' : 'none';
        }
    }
}

function clearAll() {
    points = [];
    rebuildPreviewPathPreserveProgress();
       draw();
    updatePointCount();
}

function updateResolution(value) {
    curveResolution = parseInt(value);
    const resolutionValue = document.getElementById('resolutionValue');
    if (resolutionValue) {
        resolutionValue.textContent = value;
    }
    rebuildPreviewPathPreserveProgress();
    draw();
}

function updatePointCount() {
    const pointCountEl = document.getElementById('pointCount');
    if (pointCountEl) {
        pointCountEl.textContent = points.length;
    }
}

function updateSettings() {
    // Read values from UI
    machineSettings.unit = document.getElementById('unitSelect')?.value || 'mm';
    machineSettings.scaleFactor = parseFloat(document.getElementById('scaleFactor')?.value) || 0.1;
    machineSettings.safeHeight = parseFloat(document.getElementById('safeHeight')?.value) || 5.0;
    machineSettings.cutDepth = parseFloat(document.getElementById('cutDepth')?.value) || -1.0;
    machineSettings.feedRate = parseFloat(document.getElementById('feedRate')?.value) || 300;
    machineSettings.rapidRate = parseFloat(document.getElementById('rapidRate')?.value) || 1000;
    machineSettings.angleMode = document.getElementById('angleMode')?.value || '-180-180';
    machineSettings.angleOffset = parseFloat(document.getElementById('angleOffset')?.value) || 0;
    machineSettings.shortestPath = document.getElementById('shortestPath')?.checked ?? true;
    {
        const xEl = document.getElementById('toolOffsetX');
        const yEl = document.getElementById('toolOffsetY');
        const xVal = xEl ? parseFloat(xEl.value) : NaN;
        const yVal = yEl ? parseFloat(yEl.value) : NaN;
        if (Number.isFinite(xVal)) machineSettings.toolOffsetX = xVal;
        if (Number.isFinite(yVal)) machineSettings.toolOffsetY = yVal; // allow 0
    }
    
    // Update unit labels
    const unitSuffix = machineSettings.unit === 'inch' ? 'inch' : 'mm';
    const feedUnitSuffix = machineSettings.unit === 'inch' ? 'inch/min' : 'mm/min';
    
    const els = document.querySelectorAll('.unit-label');
    els.forEach(el => {
        if (el.id.includes('feedRate') || el.id.includes('rapidRate')) {
            el.textContent = feedUnitSuffix;
        } else {
            el.textContent = unitSuffix;
        }
    });
    
    // Redraw to update tool visualization
    draw();
}

function setDeleteMode(checked) {
    deleteMode = !!checked;
}

// Initial draw
draw();
updatePointCount();
updateSettings(); // Initialize settings

// ============================================
// Phase 2: G-code I/O
// ============================================

function formatNum(n) {
    return Number.parseFloat(n).toFixed(3);
}

function samplePolylinePoints() {
    const poly = [];
    if (points.length === 0) return poly;
    if (points.length === 1) {
        poly.push({ x: points[0].x, y: points[0].y });
        return poly;
    }

    // First point
    poly.push({ x: points[0].x, y: points[0].y });

    if (points.length === 2) {
        // Linear interpolation between two points
        const p1 = points[0];
        const p2 = points[1];
        for (let t = 1 / curveResolution; t <= 1 + 1e-9; t += 1 / curveResolution) {
            const x = p1.x + (p2.x - p1.x) * t;
            const y = p1.y + (p2.y - p1.y) * t;
            poly.push({ x, y });
        }
        return poly;
    }

    // Catmull–Rom sampling for 3+ points
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        // Avoid duplicating the exact joint point: start t at 0 for first seg only
        const tStart = i === 0 ? 1 / curveResolution : 1 / curveResolution;
        for (let t = tStart; t <= 1 + 1e-9; t += 1 / curveResolution) {
            const pt = catmullRomSpline(p0, p1, p2, p3, Math.min(t, 1));
            poly.push(pt);
        }
    }
    return poly;
}

function rebuildPreviewPathPreserveProgress() {
    // Clear preview when points change - user must regenerate G-code
    preview.segments = [];
    preview.totalLength = 0;
    preview.currentDist = 0;
    preview.gcodeLoaded = false;
    updateProgressUI();
}

function buildPreviewPath() {
    // This function now only builds from G-code text, not from points
    // Called by generateGCodePreview / generateOrientedGCodePreview
}

function buildPreviewFromGCode(gcodeText) {
    const lines = gcodeText.split(/\r?\n/);
    const moves = [];
    let lastX = null, lastY = null, lastC = null;
    
    for (const raw of lines) {
        const line = raw.replace(/;.*$/,'').replace(/\(.*?\)/g,'').trim();
        if (!line) continue;
        
        // Check for G0 or G1 commands
        const isMove = /[gG]0\s/.test(line) || /[gG]1\s/.test(line);
        if (!isMove && !/[xX]/.test(line) && !/[yY]/.test(line)) continue;
        
        const xMatch = line.match(/[xX](-?\d*\.?\d+)/);
        const yMatch = line.match(/[yY](-?\d*\.?\d+)/);
        const cMatch = line.match(/[cC](-?\d*\.?\d+)/);
        
        if (xMatch) lastX = parseFloat(xMatch[1]);
        if (yMatch) lastY = parseFloat(yMatch[1]);
        if (cMatch) lastC = parseFloat(cMatch[1]);
        
        if (lastX !== null && lastY !== null) {
            // Convert scaled G-code coordinates back to canvas pixels
            // Flip Y axis: G-code Y (up positive) to canvas Y (down positive)
            const canvasX = lastX / machineSettings.scaleFactor;
            const canvasY = -lastY / machineSettings.scaleFactor;
            moves.push({ x: canvasX, y: canvasY, c: lastC });
        }
    }
    
    // Build segments from moves
    preview.segments = [];
    preview.totalLength = 0;
    let cum = 0;
    
    for (let i = 1; i < moves.length; i++) {
        const a = moves[i - 1];
        const b = moves[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len <= 1e-6) continue;
        
        // Calculate angle change for visualization
        const angleDiff = (a.c !== null && b.c !== null) ? getAngleDifference(a.c, b.c) : 0;
        
        // Store the C angle from the destination point
        const seg = { 
            x1: a.x, 
            y1: a.y, 
            x2: b.x, 
            y2: b.y, 
            len, 
            cumStart: cum, 
            cumEnd: cum + len,
            angle: b.c !== null ? b.c : null, // C-axis angle if present
            angleDiff: angleDiff // Angle change from previous segment
        };
        preview.segments.push(seg);
        cum += len;
    }
    
    preview.totalLength = cum;
    preview.currentDist = 0;
    preview.gcodeLoaded = true;
    updateProgressUI();
}

function clampPreviewDist() {
    if (preview.currentDist < 0) preview.currentDist = 0;
    if (preview.currentDist > preview.totalLength) preview.currentDist = preview.totalLength;
}

function distToPoint(d) {
    if (preview.segments.length === 0) return null;
    for (const seg of preview.segments) {
        if (d <= seg.cumEnd) {
            const t = seg.len > 0 ? (d - seg.cumStart) / seg.len : 0;
            const x = seg.x1 + (seg.x2 - seg.x1) * t;
            const y = seg.y1 + (seg.y2 - seg.y1) * t;
            const tx = seg.x2 - seg.x1;
            const ty = seg.y2 - seg.y1;
            const tl = Math.hypot(tx, ty) || 1;
            return { 
                x, 
                y, 
                nx: tx / tl, 
                ny: ty / tl,
                   angle: seg.angle, // C-axis angle from G-code
                   angleDiff: seg.angleDiff || 0
            };
        }
    }
    // End of last segment
    const last = preview.segments[preview.segments.length - 1];
    const tx = last.x2 - last.x1;
    const ty = last.y2 - last.y1;
    const tl = Math.hypot(tx, ty) || 1;
    return { 
        x: last.x2, 
        y: last.y2, 
        nx: tx / tl, 
        ny: ty / tl,
           angle: last.angle,
           angleDiff: last.angleDiff || 0
    };
}

function drawPreviewOverlay() {
    if (preview.segments.length === 0) return;
    const pt = distToPoint(preview.currentDist);
    if (!pt) return;

    const isMobile = window.innerWidth <= 768;
    const markerRadius = isMobile ? 10 : 6;
    const markerStrokeWidth = isMobile ? 3 : 2;

    previewCtx.save();

    let toolAngle = 0; // degrees
    if (preview.mode === 'oriented' && pt.angle !== null) {
        toolAngle = pt.angle;
    } else if (preview.mode === 'oriented') {
        toolAngle = Math.atan2(-pt.ny, pt.nx) * 180 / Math.PI;
    } else {
        toolAngle = 90;
    }

    const angleRad = toolAngle * Math.PI / 180;
    const offsetPixelsX = machineSettings.toolOffsetX / machineSettings.scaleFactor;
    const offsetPixelsY = machineSettings.toolOffsetY / machineSettings.scaleFactor;
    // Rotate offset in canvas coordinates (Y-down): flip Y component of rotation
    const rotatedOffsetX = offsetPixelsX * Math.cos(angleRad) + offsetPixelsY * Math.sin(angleRad);
    const rotatedOffsetY = offsetPixelsX * Math.sin(angleRad) - offsetPixelsY * Math.cos(angleRad);

    // Tool tip is on the path (cutting point), C-axis origin is offset backwards
    const tipX = pt.x;
    const tipY = pt.y;
    const originX = tipX - rotatedOffsetX;
    const originY = tipY - rotatedOffsetY;

    // Origin marker
    previewCtx.fillStyle = '#3498db';
    previewCtx.strokeStyle = '#2980b9';
    previewCtx.lineWidth = markerStrokeWidth;
    previewCtx.beginPath();
    previewCtx.arc(originX, originY, markerRadius, 0, Math.PI * 2);
    previewCtx.fill();
    previewCtx.stroke();

    // Line
    previewCtx.strokeStyle = '#95a5a6';
    previewCtx.lineWidth = isMobile ? 2 : 1;
    previewCtx.setLineDash([3, 3]);
    previewCtx.beginPath();
    previewCtx.moveTo(originX, originY);
    previewCtx.lineTo(tipX, tipY);
    previewCtx.stroke();
    previewCtx.setLineDash([]);

    // Tip marker
    previewCtx.fillStyle = '#2ecc71';
    previewCtx.strokeStyle = '#145a32';
    previewCtx.lineWidth = markerStrokeWidth;
    previewCtx.beginPath();
    previewCtx.arc(tipX, tipY, markerRadius, 0, Math.PI * 2);
    previewCtx.fill();
    previewCtx.stroke();

    if (preview.showDirection) {
        // In base mode, keep arrow fixed pointing up. In oriented mode, align with path tangent.
        const arrowAngleRad = (preview.mode === 'oriented')
            ? Math.atan2(-pt.ny, pt.nx) // tangent direction
            : -Math.PI / 2;             // fixed up (canvas up)
        const dirX = Math.cos(arrowAngleRad);
        const dirY = Math.sin(arrowAngleRad);
        const L = isMobile ? 36 : 24;
        const ax = tipX + dirX * L;
        const ay = tipY + dirY * L;

        let arrowColor = preview.mode === 'oriented' ? '#ff6600' : '#27ae60';
        if (preview.mode === 'oriented' && pt.angleDiff !== undefined) {
            const absChange = Math.abs(pt.angleDiff);
            if (absChange > 90) arrowColor = '#e74c3c';
            else if (absChange > 45) arrowColor = '#f39c12';
            else if (absChange > 15) arrowColor = '#f1c40f';
            else arrowColor = '#2ecc71';
        }

        previewCtx.strokeStyle = arrowColor;
        previewCtx.lineWidth = isMobile ? 3 : 2;
        previewCtx.beginPath();
        previewCtx.moveTo(tipX, tipY);
        previewCtx.lineTo(ax, ay);
        previewCtx.stroke();

        const left = rotate(-Math.PI / 6, dirX, dirY);
        const right = rotate(Math.PI / 6, dirX, dirY);
        const h = isMobile ? 15 : 10;
        previewCtx.beginPath();
        previewCtx.moveTo(ax, ay);
        previewCtx.lineTo(ax - left.x * h, ay - left.y * h);
        previewCtx.moveTo(ax, ay);
        previewCtx.lineTo(ax - right.x * h, ay - right.y * h);
        previewCtx.stroke();

        if (preview.mode === 'oriented' && pt.angle !== null) {
            previewCtx.fillStyle = '#000000';
            previewCtx.font = isMobile ? 'bold 16px Arial' : 'bold 12px Arial';
            previewCtx.textAlign = 'left';
            previewCtx.textBaseline = 'top';
            const angleText = `C: ${formatNum(pt.angle)}°`;
            const changeText = pt.angleDiff !== undefined ? ` (Δ${formatNum(pt.angleDiff)}°)` : '';
            const textOffset = isMobile ? 16 : 12;
            previewCtx.fillText(angleText + changeText, tipX + textOffset, tipY + textOffset);

            if (pt.angleDiff !== undefined && Math.abs(pt.angleDiff) > 90) {
                previewCtx.fillStyle = '#e74c3c';
                previewCtx.font = isMobile ? 'bold 14px Arial' : 'bold 10px Arial';
                const warningOffset = isMobile ? 32 : 26;
                previewCtx.fillText('⚠ Large rotation', tipX + textOffset, tipY + warningOffset);
            }
        }

        previewCtx.fillStyle = '#2980b9';
        previewCtx.font = isMobile ? '12px Arial' : '10px Arial';
        previewCtx.textAlign = 'center';
        previewCtx.textBaseline = 'bottom';
        previewCtx.fillText('Origin', originX, originY - (isMobile ? 16 : 12));

        previewCtx.fillStyle = '#145a32';
        previewCtx.fillText('Tip', tipX, tipY - (isMobile ? 16 : 12));
    }

    previewCtx.restore();
}

function rotate(angle, x, y) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return { x: c * x - s * y, y: s * x + c * y };
}

// Animation loop
function step(ts) {
    if (!preview.playing) return; // stop loop when paused
    if (preview.lastTs == null) preview.lastTs = ts;
    const dt = (ts - preview.lastTs) / 1000; // seconds
    preview.lastTs = ts;
    preview.currentDist += preview.speedPxPerSec * dt;
    if (preview.currentDist >= preview.totalLength) {
        preview.currentDist = preview.totalLength;
        updateProgressUI();
        drawPreview();
        togglePlay(false); // auto-stop at end
        return;
    }
    updateProgressUI();
    drawPreview();
    requestAnimationFrame(step);
}

// Playback controls (wired from HTML)
function togglePlay(forceState) {
    if (!preview.gcodeLoaded) {
        alert('Please generate G-code first by clicking "Generate G-code" or "Generate Oriented G-code"');
        return;
    }
    const want = forceState !== undefined ? forceState : !preview.playing;
    if (preview.totalLength <= 0) {
        alert('No path to preview. Please generate G-code first.');
        return;
    }
    preview.playing = want;
    const btn = document.getElementById('btnPlayPause');
    const label = want ? '⏸' : '▶';
    if (btn) btn.textContent = label;
    if (want) {
        preview.lastTs = null;
        requestAnimationFrame(step);
    }
}

function resetPreview() {
    preview.currentDist = 0;
    preview.lastTs = null;
    togglePlay(false);
    updateProgressUI();
    drawPreview();
}

function updatePreviewSpeed(v) {
    const n = parseFloat(v);
    preview.speedPxPerSec = isFinite(n) ? n : preview.speedPxPerSec;
    const el = document.getElementById('previewSpeedValue');
    if (el) el.textContent = `${Math.round(preview.speedPxPerSec)} px/s`;
}

function toggleDirection(checked) {
    preview.showDirection = !!checked;
    drawPreview();
}

function setPreviewMode(mode) {
    if (!preview.gcodeLoaded) {
        alert('Please generate G-code first.');
        // Reset radio to current mode
        const currentRadio = document.querySelector(`input[name="previewMode"][value="${preview.mode}"]`);
        if (currentRadio) currentRadio.checked = true;
        return;
    }
    
    preview.mode = mode; // 'base' or 'oriented'
    
    // Rebuild preview from the appropriate G-code
    if (mode === 'base') {
        const baseGcode = document.getElementById('gcodeOutput')?.value;
        if (baseGcode) {
            buildPreviewFromGCode(baseGcode);
        }
    } else {
        const orientedGcode = document.getElementById('gcodeOutputOriented')?.value;
        if (orientedGcode) {
            buildPreviewFromGCode(orientedGcode);
        }
    }
    
    drawPreview();
}

function updateProgressUI() {
    const pct = preview.totalLength > 0 ? (preview.currentDist / preview.totalLength) * 100 : 0;
    const slider = document.getElementById('previewProgress');
    const label = document.getElementById('previewProgressValue');
    if (slider && !slider._scrubbing) slider.value = pct.toFixed(1);
    if (label) label.textContent = `${pct.toFixed(1)}%`;
}

// Hook progress slider scrubbing
const progressEl = document.getElementById('previewProgress');
if (progressEl) {
    progressEl.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        e.target._scrubbing = true;
    preview.currentDist = preview.totalLength * (v / 100);
    clampPreviewDist();
    drawPreview();
        const label = document.getElementById('previewProgressValue');
        if (label) label.textContent = `${v.toFixed(1)}%`;
    });
    progressEl.addEventListener('change', (e) => {
        e.target._scrubbing = false;
    });
}

// Initialize preview values and path
updatePreviewSpeed(document.getElementById('previewSpeed')?.value || preview.speedPxPerSec);
// Don't build preview path on init - user must generate G-code first
updateProgressUI();

function generateGCodeString() {
    const poly = samplePolylinePoints();
    const lines = [];
    const now = new Date();
    const { unit, scaleFactor, safeHeight, cutDepth, feedRate, rapidRate } = machineSettings;
    const unitCode = unit === 'inch' ? 'G20' : 'G21';
    
    lines.push(`; TangentCNC G-code`);
    lines.push(`; Generated: ${now.toISOString()}`);
    lines.push(`; Units: ${unit}`);
    lines.push(`; Scale: ${scaleFactor} (canvas pixels to ${unit})`);
    lines.push(`G90    ; Absolute positioning`);
    lines.push(`${unitCode}   ; Unit: ${unit}`);
    lines.push(`G17    ; XY plane`);
    lines.push(`F${formatNum(rapidRate)} ; Rapid feed rate`);

    if (poly.length > 0) {
        const p0 = poly[0];
        const x0 = p0.x * scaleFactor;
        const y0 = -p0.y * scaleFactor; // Flip Y axis: canvas down = negative, CNC up = positive
        
        // Move to safe height, then to start position, then down to cut depth
        lines.push(`G0 Z${formatNum(safeHeight)} ; Safe height`);
        lines.push(`G0 X${formatNum(x0)} Y${formatNum(y0)}`);
        lines.push(`G1 Z${formatNum(cutDepth)} F${formatNum(feedRate)} ; Plunge to cut depth`);
        
        for (let i = 1; i < poly.length; i++) {
            const p = poly[i];
            const x = p.x * scaleFactor;
            const y = -p.y * scaleFactor; // Flip Y axis
            lines.push(`G1 X${formatNum(x)} Y${formatNum(y)} F${formatNum(feedRate)}`);
        }
        
        // Retract to safe height
        lines.push(`G0 Z${formatNum(safeHeight)} ; Retract`);
    }

    lines.push(`M2     ; Program end`);
    return lines.join("\n");
}

function generateGCodePreview() {
    const textarea = document.getElementById('gcodeOutput');
    if (!textarea) return;
    const gcode = generateGCodeString();
    textarea.value = gcode;
    
    // Build preview from the generated G-code
    buildPreviewFromGCode(gcode);
    preview.mode = 'base'; // Set to base mode
    document.querySelector('input[name="previewMode"][value="base"]').checked = true;
    
    const panel = document.getElementById('gcodePreviewPanel');
    if (panel && !panel.open) panel.open = true;
    
    drawPreview(); // Redraw preview
}

// Oriented G-code generation (adds C axis and ORI comments)
function angleDeg(dx, dyCanvas) {
    // Convert canvas dy (down positive) to geometric dy (up positive)
    const dy = -dyCanvas;
    const ang = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180
    return ((ang % 360) + 360) % 360; // 0..360
}

function normalizeAngle(angle, prevAngle = null) {
    const { angleMode, angleOffset, shortestPath } = machineSettings;
    
    // Apply offset
    let normalized = angle + angleOffset;
    
    // Normalize to desired range
    if (angleMode === '-180-180') {
        // Normalize to -180 to 180
        while (normalized > 180) normalized -= 360;
        while (normalized <= -180) normalized += 360;
    } else {
        // Normalize to 0 to 360
        normalized = ((normalized % 360) + 360) % 360;
    }
    
    // If shortest path is enabled and we have a previous angle, adjust for minimal rotation
    if (shortestPath && prevAngle !== null) {
        const diff = normalized - prevAngle;
        
        // If the difference is > 180, we can go the other way
        if (diff > 180) {
            normalized -= 360;
        } else if (diff < -180) {
            normalized += 360;
        }
    }
    
    return normalized;
}

function getAngleDifference(angle1, angle2) {
    let diff = angle2 - angle1;
    // Normalize to -180 to 180
    while (diff > 180) diff -= 360;
    while (diff <= -180) diff += 360;
    return Math.abs(diff);
}

function generateOrientedGCodeFromBase(baseGcode) {
    // Parse base G-code to extract XY moves
    const lines = baseGcode.split(/\r?\n/);
    const outputLines = [];
    const moves = []; // Track XY positions for tangent calculation
    let lastX = null, lastY = null;
    
    // First pass: collect all XY positions
    for (const raw of lines) {
        const line = raw.replace(/;.*$/,'').trim();
        if (!line) continue;
        
        const xMatch = line.match(/[xX](-?\d*\.?\d+)/);
        const yMatch = line.match(/[yY](-?\d*\.?\d+)/);
        
        if (xMatch) lastX = parseFloat(xMatch[1]);
        if (yMatch) lastY = parseFloat(yMatch[1]);
        
        if (lastX !== null && lastY !== null) {
            moves.push({ x: lastX, y: lastY });
        }
    }
    
    // Reset for second pass
    lastX = null;
    lastY = null;
    let moveIndex = 0;
        let prevAngle = null;
    
    // Second pass: process lines and add C-axis
    for (const raw of lines) {
        const commentMatch = raw.match(/;(.*)$/);
        const comment = commentMatch ? commentMatch[1] : '';
        const line = raw.replace(/;.*$/,'').trim();
        
        // Pass through comments and empty lines
        if (!line) {
            outputLines.push(raw);
            continue;
        }
        
        // Pass through non-motion commands as-is
        if (!/[gG][01]\s/.test(line) && !/[xX]/.test(line) && !/[yY]/.test(line)) {
            outputLines.push(raw);
            continue;
        }
        
        // Extract coordinates
        const xMatch = line.match(/[xX](-?\d*\.?\d+)/);
        const yMatch = line.match(/[yY](-?\d*\.?\d+)/);
        const zMatch = line.match(/[zZ](-?\d*\.?\d+)/);
        const fMatch = line.match(/[fF](-?\d*\.?\d+)/);
        const gMatch = line.match(/[gG]([01])\s/);
        
        if (xMatch) lastX = parseFloat(xMatch[1]);
        if (yMatch) lastY = parseFloat(yMatch[1]);
        
        // If this is an XY move, calculate orientation
        if (lastX !== null && lastY !== null && moveIndex < moves.length) {
            let angle = 0;
            
            // Calculate tangent from previous to current point
            if (moveIndex > 0) {
                const prev = moves[moveIndex - 1];
                const curr = moves[moveIndex];
                const dx = curr.x - prev.x;
                const dy = curr.y - prev.y;
                
                if (Math.hypot(dx, dy) > 1e-6) {
                    angle = angleDeg(dx, dy);
                }
            } else if (moveIndex === 0 && moves.length > 1) {
                // First point: use direction to next point
                const curr = moves[0];
                const next = moves[1];
                const dx = next.x - curr.x;
                const dy = next.y - curr.y;
                
                if (Math.hypot(dx, dy) > 1e-6) {
                    angle = angleDeg(dx, dy);
                }
            }
            
                // Apply normalization and shortest path
                angle = normalizeAngle(angle, prevAngle);
                prevAngle = angle;
            
            // Reconstruct the G-code line with C-axis
            let newLine = '';
            if (gMatch) newLine += `G${gMatch[1]} `;
            if (xMatch) newLine += `X${formatNum(lastX)} `;
            if (yMatch) newLine += `Y${formatNum(lastY)} `;
            if (zMatch) newLine += `Z${zMatch[1]} `;
            newLine += `C${formatNum(angle)} `;
            if (fMatch) newLine += `F${fMatch[1]} `;
            
            newLine = newLine.trim();
            newLine += ` ; ORI=${formatNum(angle)}deg`;
            if (comment) newLine += ` ${comment}`;
            
            outputLines.push(newLine);
            moveIndex++;
        } else {
            // Non-XY move, pass through as-is
            outputLines.push(raw);
        }
    }
    
    return outputLines.join('\n');
}

function generateOrientedGCodeString() {
    // Check if base G-code exists in the left panel
    const baseGcodeEl = document.getElementById('gcodeOutput');
    const baseGcode = baseGcodeEl?.value || '';
    
    if (!baseGcode.trim()) {
        // Fallback: generate from points if no base G-code
        return generateOrientedGCodeFromPoints();
    }
    
    // Generate oriented version from base G-code
    const oriented = generateOrientedGCodeFromBase(baseGcode);
    
    // Update header to indicate it's based on imported/generated G-code
    const now = new Date();
    const header = `; TangentCNC G-code (with orientation)\n; Generated: ${now.toISOString()}\n; Source: Base G-code with C-axis orientation added\n`;
    
    return header + oriented.split('\n').filter(l => !l.startsWith('; TangentCNC') && !l.startsWith('; Generated:')).join('\n');
}

function generateOrientedGCodeFromPoints() {
    // Original implementation: generate from points directly
    const poly = samplePolylinePoints();
    const lines = [];
    const now = new Date();
    const { unit, scaleFactor, safeHeight, cutDepth, feedRate, rapidRate } = machineSettings;
    const unitCode = unit === 'inch' ? 'G20' : 'G21';
    
    lines.push(`; TangentCNC G-code (with orientation)`);
    lines.push(`; Generated: ${now.toISOString()}`);
    lines.push(`; Units: ${unit}`);
    lines.push(`; Scale: ${scaleFactor} (canvas pixels to ${unit})`);
    lines.push(`; Orientation C: heading in degrees (0° = +X, CCW+, Y up)`);
    lines.push(`; ORI: same heading in comment for controllers without C-axis`);
    lines.push(`G90    ; Absolute positioning`);
    lines.push(`${unitCode}   ; Unit: ${unit}`);
    lines.push(`G17    ; XY plane`);
    lines.push(`F${formatNum(rapidRate)} ; Rapid feed rate`);

    if (poly.length > 0) {
        const p0 = poly[0];
        const x0 = p0.x * scaleFactor;
        const y0 = -p0.y * scaleFactor; // Flip Y axis
        
        // First heading from first segment if exists, else 0
        let c0 = 0;
        if (poly.length > 1) {
            const vdx = poly[1].x - poly[0].x;
            const vdy = poly[1].y - poly[0].y;
            c0 = angleDeg(vdx, vdy);
        }
            c0 = normalizeAngle(c0, null);
            let prevAngle = c0;
        
        // Move to safe height, then to start position with orientation, then down
        lines.push(`G0 Z${formatNum(safeHeight)} ; Safe height`);
        lines.push(`G0 X${formatNum(x0)} Y${formatNum(y0)} C${formatNum(c0)} ; ORI=${formatNum(c0)}deg`);
        lines.push(`G1 Z${formatNum(cutDepth)} F${formatNum(feedRate)} ; Plunge to cut depth`);
        
        for (let i = 1; i < poly.length; i++) {
            const prev = poly[i - 1];
            const p = poly[i];
            const dx = p.x - prev.x;
            const dy = p.y - prev.y;
            const c = angleDeg(dx, dy);
                const normalizedC = normalizeAngle(c, prevAngle);
                prevAngle = normalizedC;
            const x = p.x * scaleFactor;
            const y = -p.y * scaleFactor; // Flip Y axis
                lines.push(`G1 X${formatNum(x)} Y${formatNum(y)} C${formatNum(normalizedC)} F${formatNum(feedRate)} ; ORI=${formatNum(normalizedC)}deg`);
        }
        
        // Retract to safe height
        lines.push(`G0 Z${formatNum(safeHeight)} ; Retract`);
    }

    lines.push(`M2     ; Program end`);
    return lines.join("\n");
}

function generateOrientedGCodePreview() {
    const left = document.getElementById('gcodeOutput');
    const right = document.getElementById('gcodeOutputOriented');
    
    // Check if base G-code already exists
    let baseGcode = left?.value || '';
    
    // Only generate base G-code if it doesn't exist
    if (!baseGcode.trim()) {
        baseGcode = generateGCodeString();
        if (left) left.value = baseGcode;
    }
    
    // Generate oriented G-code from existing base
    const orientedGcode = generateOrientedGCodeString();
    if (right) right.value = orientedGcode;
    
    // Build preview from the oriented G-code
    buildPreviewFromGCode(orientedGcode);
    preview.mode = 'oriented'; // Set to oriented mode
    document.querySelector('input[name="previewMode"][value="oriented"]').checked = true;
    
    const panel = document.getElementById('gcodePreviewPanel');
    if (panel && !panel.open) panel.open = true;
    
    drawPreview(); // Redraw preview
}

function downloadOrientedGCode() {
    const gcode = generateOrientedGCodeString();
    const blob = new Blob([gcode], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `tangentcnc_oriented_${ts}.nc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function downloadGCode() {
    // Ensure preview is up-to-date
    const gcode = generateGCodeString();
    const blob = new Blob([gcode], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `tangentcnc_${ts}.nc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Import G-code
const gcodeFileInput = document.getElementById('gcodeFileInput');
if (gcodeFileInput) {
    gcodeFileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const text = String(reader.result || '');
                const parsed = parseGCode(text);
                if (parsed.length > 0) {
                    points = parsed;
                    draw();
                    updatePointCount();
                    generateGCodePreview();
                } else {
                    alert('No XY moves found in the selected G-code.');
                }
            } catch (err) {
                console.error(err);
                alert('Failed to parse G-code.');
            }
        };
        reader.readAsText(file);
        // Reset value to allow re-selecting the same file
        e.target.value = '';
    });
}

function parseGCode(text) {
    const xs = [];
    const ys = [];
    const out = [];
    const lines = text.split(/\r?\n/);
    let lastX = null;
    let lastY = null;
    for (const raw of lines) {
        const line = raw.replace(/;.*$/,'').replace(/\(.*?\)/g,'').trim(); // strip comments ; and ( ) blocks
        if (!line) continue;
        // Only consider motion commands or lines with X/Y
        if (!/[gG][0-9]+/.test(line) && !/[xX]/.test(line) && !/[yY]/.test(line)) continue;
        const xMatch = line.match(/[xX](-?\d*\.?\d+)/);
        const yMatch = line.match(/[yY](-?\d*\.?\d+)/);
        if (xMatch) lastX = parseFloat(xMatch[1]);
        if (yMatch) lastY = parseFloat(yMatch[1]);
        if (lastX !== null && lastY !== null) {
            // Convert G-code units back to canvas pixels and flip Y axis
            // G-code uses real units, canvas uses pixels: canvas = real / scaleFactor
            const sf = Number(machineSettings.scaleFactor) || 1;
            out.push({ x: lastX / sf, y: -lastY / sf });
        }
    }
    return out;
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', function() {
    // Ensure editor is hidden initially
    // Initialize canvas elements
    canvas = document.getElementById('canvas');
    ctx = canvas ? canvas.getContext('2d') : null;
    previewCanvas = document.getElementById('previewCanvas');
    previewCtx = previewCanvas ? previewCanvas.getContext('2d') : null;
    
    // Ensure editor is hidden initially
    const editorContainer = document.getElementById('editorCanvasContainer');
    const drawModePanel = document.getElementById('drawModePanel');
    if (editorContainer) {
        editorContainer.style.display = 'none';
    }
    if (drawModePanel) {
        drawModePanel.style.display = 'none';
    }
    
    // Set up event listeners for canvas
    setupCanvasEventListeners();
    
    // Initial draw for editor canvas
    if (canvas && ctx) {
        draw();
    }
    
    // Initial draw for preview canvas
    if (previewCanvas && previewCtx) {
        drawPreview();
    }
});
