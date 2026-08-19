/* ============================================================================
   Dallal Dashboard — REDESIGN PREVIEW: modern chart theme
   Loaded ONLY by index-v2.html, AFTER Chart.js and BEFORE app.js. It wraps the
   Chart constructor so every chart app.js creates gets a modern "AI-era" look —
   smooth gradient area fills, soft gridlines, rounded bars, pill legends,
   rounded tooltips — without changing a single line of app.js.
   ========================================================================== */
(function () {
  if (!window.Chart) return;
  var Base = window.Chart;

  var MUTED = '#8798ad', GRID = 'rgba(120,140,170,.13)';
  var PALETTE = ['#5a5be6', '#0ea89a', '#f5883f', '#2f6df6', '#ec4899', '#7c5cff', '#0f8b8d'];

  // ---- modern global defaults ----------------------------------------------
  try {
    Base.defaults.font.family = "'Fira Sans',system-ui,-apple-system,sans-serif";
    Base.defaults.font.size = 11.5;
    Base.defaults.color = MUTED;
    Base.defaults.maintainAspectRatio = false;
    Base.defaults.plugins = Base.defaults.plugins || {};
    Base.defaults.plugins.legend = Base.defaults.plugins.legend || {};
    Base.defaults.plugins.legend.labels = Object.assign({}, Base.defaults.plugins.legend.labels, {
      usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16,
      color: MUTED, font: { size: 11.5, weight: '600' }
    });
    Base.defaults.plugins.tooltip = Object.assign({}, Base.defaults.plugins.tooltip, {
      backgroundColor: 'rgba(20,24,54,.95)', titleColor: '#fff', bodyColor: '#e7e9f7',
      padding: 12, cornerRadius: 12, boxPadding: 6, usePointStyle: true,
      borderColor: 'rgba(255,255,255,.08)', borderWidth: 1,
      titleFont: { size: 12, weight: '700' }, bodyFont: { size: 12 }
    });
    Base.defaults.elements = Base.defaults.elements || {};
    Base.defaults.elements.point = Object.assign({}, Base.defaults.elements.point, { hoverRadius: 5 });
  } catch (e) { /* ignore */ }

  function hexA(hex, a) {
    if (typeof hex !== 'string' || hex[0] !== '#') return 'rgba(90,91,230,' + a + ')';
    var n = hex.slice(1); if (n.length === 3) n = n.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function gradFor(color) {
    return function (ctx) {
      var area = ctx.chart.chartArea; if (!area) return hexA(color, 0.12);
      var g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, hexA(color, 0.34)); g.addColorStop(1, hexA(color, 0.02));
      return g;
    };
  }

  function themeConfig(cfg) {
    if (!cfg || cfg._v2themed) return; cfg._v2themed = true;
    var topType = cfg.type || 'line';
    var ds = (cfg.data && cfg.data.datasets) || [];
    var radial = /doughnut|pie|polarArea|radar/.test(topType) ||
                 ds.some(function (d) { return /doughnut|pie/.test(d.type || ''); });
    var o = cfg.options = cfg.options || {};
    if (o.animation == null) o.animation = { duration: 650, easing: 'easeOutQuart' };

    ds.forEach(function (d, i) {
      var dt = d.type || topType;
      var col = (typeof d.borderColor === 'string' && d.borderColor) ||
                (typeof d.backgroundColor === 'string' && d.backgroundColor !== 'transparent' && d.backgroundColor) ||
                PALETTE[i % PALETTE.length];
      if (dt === 'line') {
        if (d.tension == null) d.tension = 0.4;
        if (d.borderWidth == null) d.borderWidth = 2.6;
        d.borderColor = col; d.borderCapStyle = 'round';
        if (d.pointRadius == null) d.pointRadius = 0;
        d.pointHoverRadius = 5; d.pointHoverBackgroundColor = col;
        d.pointHoverBorderColor = '#fff'; d.pointHoverBorderWidth = 2;
        // Only fill (with a gradient) lines that were meant to be filled — leave
        // overlay/trend lines as clean strokes.
        var wantFill = d.fill === true ||
          (d.fill == null && typeof d.backgroundColor === 'string' && d.backgroundColor && d.backgroundColor !== 'transparent');
        if (wantFill) { d.fill = true; d.backgroundColor = gradFor(col); }
      } else if (dt === 'bar') {
        if (d.borderRadius == null) d.borderRadius = 7;
        d.borderSkipped = false;
        if (d.maxBarThickness == null) d.maxBarThickness = 36;
      }
    });

    if (radial) {
      if (o.cutout == null && /doughnut/.test(topType)) o.cutout = '72%';
      return;
    }
    o.scales = o.scales || { x: {}, y: {} };
    Object.keys(o.scales).forEach(function (k) {
      var s = o.scales[k] = o.scales[k] || {};
      s.grid = Object.assign({ color: GRID, drawTicks: false, lineWidth: 1 }, s.grid || {});
      s.border = Object.assign({ display: false }, s.border || {});
      s.ticks = Object.assign({ color: MUTED, padding: 8 }, s.ticks || {}, { font: Object.assign({ size: 11 }, (s.ticks || {}).font) });
      if (/^x/.test(k)) s.grid.display = false;     // horizontal-only gridlines
    });
  }

  // ---- wrap the constructor -------------------------------------------------
  window.Chart = new Proxy(Base, {
    construct: function (T, args) { try { themeConfig(args[1]); } catch (e) { /* ignore */ } return new T(args[0], args[1]); },
    get: function (t, p) { var v = t[p]; return typeof v === 'function' ? v.bind(t) : v; }
  });
})();
