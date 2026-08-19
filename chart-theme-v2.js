/* ============================================================================
   Dallal Dashboard — REDESIGN PREVIEW: modern chart theme (v2)
   Loaded ONLY by index-v2.html, AFTER Chart.js and BEFORE app.js.
   Uses Chart.js GLOBAL DEFAULTS (reliable — they apply unless a chart explicitly
   overrides) + one small plugin for gradient area fills. No app.js changes.
   ========================================================================== */
(function () {
  if (!window.Chart) return;
  var C = window.Chart;
  var MUTED = '#8f9fb5', GRID = 'rgba(125,142,170,.16)';
  var PALETTE = ['#5a5be6', '#0ea89a', '#f5883f', '#2f6df6', '#ec4899', '#7c5cff', '#0f8b8d'];

  try {
    // Typography + base
    C.defaults.font.family = "'Fira Sans',system-ui,-apple-system,sans-serif";
    C.defaults.font.size = 11.5;
    C.defaults.color = MUTED;
    C.defaults.borderColor = GRID;
    C.defaults.maintainAspectRatio = false;
    C.defaults.animation = { duration: 700, easing: 'easeOutQuart' };

    // Lines: smooth + round caps, hidden points until hover
    C.defaults.elements.line.tension = 0.42;
    C.defaults.elements.line.borderCapStyle = 'round';
    C.defaults.elements.line.borderJoinStyle = 'round';
    C.defaults.elements.point.radius = 0;
    C.defaults.elements.point.hoverRadius = 5;
    C.defaults.elements.point.hoverBorderWidth = 2;
    C.defaults.elements.point.hoverBorderColor = '#fff';
    // Bars: rounded, no baseline clipping
    C.defaults.elements.bar.borderRadius = 8;
    C.defaults.elements.bar.borderSkipped = false;
    C.defaults.elements.bar.maxBarThickness = 40;
    // Arcs (doughnut/gauge): thin gaps
    C.defaults.elements.arc.borderWidth = 0;

    // Scales — soft, horizontal-only gridlines, no axis borders
    ['linear', 'logarithmic'].forEach(function (t) {
      if (!C.defaults.scales[t]) return;
      C.defaults.scales[t].grid = Object.assign({}, C.defaults.scales[t].grid, { color: GRID, drawTicks: false, lineWidth: 1 });
      C.defaults.scales[t].border = Object.assign({}, C.defaults.scales[t].border, { display: false });
      C.defaults.scales[t].ticks = Object.assign({}, C.defaults.scales[t].ticks, { color: MUTED, padding: 10, font: { size: 11 } });
    });
    ['category', 'time', 'timeseries'].forEach(function (t) {
      if (!C.defaults.scales[t]) return;
      C.defaults.scales[t].grid = Object.assign({}, C.defaults.scales[t].grid, { display: false, drawTicks: false });
      C.defaults.scales[t].border = Object.assign({}, C.defaults.scales[t].border, { display: false });
      C.defaults.scales[t].ticks = Object.assign({}, C.defaults.scales[t].ticks, { color: MUTED, padding: 10, font: { size: 11 } });
    });

    // Legend — circular pills
    C.defaults.plugins.legend.labels = Object.assign({}, C.defaults.plugins.legend.labels, {
      usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16,
      color: MUTED, font: { size: 11.5, weight: '600' }
    });
    // Tooltip — rounded dark card
    C.defaults.plugins.tooltip = Object.assign({}, C.defaults.plugins.tooltip, {
      backgroundColor: 'rgba(19,22,52,.96)', titleColor: '#fff', bodyColor: '#e7e9f7',
      padding: 12, cornerRadius: 12, boxPadding: 6, usePointStyle: true, caretSize: 6,
      borderColor: 'rgba(255,255,255,.08)', borderWidth: 1,
      titleFont: { size: 12, weight: '700' }, bodyFont: { size: 12 }
    });
  } catch (e) { /* ignore */ }

  function hexA(hex, a) {
    if (typeof hex !== 'string' || hex[0] !== '#') return 'rgba(90,91,230,' + a + ')';
    var n = hex.slice(1); if (n.length === 3) n = n.split('').map(function (c) { return c + c; }).join('');
    return 'rgba(' + parseInt(n.slice(0, 2), 16) + ',' + parseInt(n.slice(2, 4), 16) + ',' + parseInt(n.slice(4, 6), 16) + ',' + a + ')';
  }

  // Gradient area fills: for every FILLED line dataset, swap the flat fill for a
  // top→transparent gradient of the line's own colour.
  var GradientFill = {
    id: 'dallalGradientFill',
    beforeDatasetsUpdate: function (chart) {
      (chart.data.datasets || []).forEach(function (d, i) {
        var dt = d.type || chart.config.type;
        if (dt !== 'line') return;
        var filled = d.fill === true || d.fill === 'origin' || d.fill === 'start' ||
          (d.fill == null && typeof d.backgroundColor === 'string' && d.backgroundColor && d.backgroundColor !== 'transparent');
        if (!filled) return;
        var col = (typeof d.borderColor === 'string' && d.borderColor) || PALETTE[i % PALETTE.length];
        var area = chart.chartArea; if (!area) return;
        var g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, hexA(col, 0.32)); g.addColorStop(1, hexA(col, 0.015));
        d.fill = true; d.backgroundColor = g;
      });
    }
  };
  try { C.register(GradientFill); } catch (e) { /* ignore */ }
})();
