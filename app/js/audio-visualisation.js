"use strict";

var fftSize = 512;
var smoothingTimeConstant = 0.6;

if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = ( function() {
    return window.webkitRequestAnimationFrame ||
           window.mozRequestAnimationFrame ||
           window.oRequestAnimationFrame ||
           window.msRequestAnimationFrame ||
           function(callback, element ) {
             window.setTimeout( callback, 1000 / 60 );
           };
  })();
};

var audioContext = new (window.AudioContext || window.webkitAudioContext)();

var $audioElement = $("#player");
var audioElement = $audioElement.get(0);

var audioSource = audioContext.createMediaElementSource(audioElement);
var analyser = audioContext.createAnalyser();
analyser.fftSize = fftSize;
analyser.smoothingTimeConstant = smoothingTimeConstant;

audioSource.connect(analyser);
analyser.connect(audioContext.destination);

var frequencyData = new Uint8Array(analyser.frequencyBinCount);
var timeDomainData = new Uint8Array(analyser.frequencyBinCount);

var chart = $("#chart").kendoChart({
  renderAs: "canvas",
  categoryAxis: {
    majorGridLines: { visible: false },
    visible: false
  },
  legend: { visible: false },
  seriesDefaults: {
    border: { width: 0 },
    labels: { visible: false },
    line: {
      width: 2
    },
    markers: { visible: false },
    overlay: { gradient: null },
    type: "column"
  },
  series: [
    { field: "frequencies" },
    { field: "timeDomains", type: "line" }
  ],
  theme: "bootstrap",
  transitions: false,
  valueAxis: {
    majorGridLines: { visible: false },
    max: 250,
    visible: false
  }
}).data("kendoChart");

var draw = function() {
  window.requestAnimationFrame(draw);
  analyser.getByteFrequencyData(frequencyData);
  analyser.getByteTimeDomainData(timeDomainData);

  chart.options.series[0].data = Array.apply([], frequencyData);
  chart.options.series[1].data = Array.apply([], timeDomainData);

  chart.redraw();
};

draw();