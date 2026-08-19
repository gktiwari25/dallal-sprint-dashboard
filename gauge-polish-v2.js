/* ============================================================================
   Dallal Dashboard — REDESIGN PREVIEW: gauge polish (SCOPED, safe)
   Loaded only by index-v2.html, after Chart.js, before app.js. A Chart.js plugin
   that ONLY touches gauge rings — doughnuts whose dataset is exactly [value,
   remainder]. It rounds the ring ends, gives the value arc a gradient, and makes
   the track visible. It never touches line/bar/other doughnut charts, so it
   can't repeat the earlier breakage.
   ========================================================================== */
(function () {
  if (!window.Chart) return;
  var C = window.Chart;

  function toRgb(hex) {
    if (typeof hex !== 'string' || hex[0] !== '#') return [90, 91, 230];
    var n = hex.slice(1); if (n.length === 3) n = n.split('').map(function (c) { return c + c; }).join('');
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  }
  function lighten(hex, amt) {
    var c = toRgb(hex);
    return 'rgb(' + c.map(function (v) { return Math.round(v + (255 - v) * amt); }).join(',') + ')';
  }

  function isGauge(chart) {
    if (chart.config.type !== 'doughnut') return false;
    var ds = chart.data.datasets && chart.data.datasets[0];
    return !!(ds && Array.isArray(ds.data) && ds.data.length === 2);
  }

  C.register({
    id: 'dallalGaugePolish',
    beforeDatasetsUpdate: function (chart) {
      if (!isGauge(chart)) return;
      var ds = chart.data.datasets[0];
      // original value colour (first entry of the [color, track] array app.js sets)
      var col = Array.isArray(ds.backgroundColor)
        ? (typeof ds.backgroundColor[0] === 'string' ? ds.backgroundColor[0] : '#5a5be6')
        : (typeof ds.backgroundColor === 'string' ? ds.backgroundColor : '#5a5be6');
      // rounded ends on the value arc, flat track
      ds.borderRadius = [12, 0];
      ds.borderWidth = 0;
      ds.spacing = 0;
      // gradient value arc + a soft-but-visible track
      var fill = col, area = chart.chartArea;
      if (area) {
        var g = chart.ctx.createLinearGradient(area.left, area.top, area.right, area.bottom);
        g.addColorStop(0, col);
        g.addColorStop(1, lighten(col, 0.42));
        fill = g;
      }
      ds.backgroundColor = [fill, 'rgba(120,140,170,.16)'];
    }
  });
})();
