// Utilidades de Web Audio para los tonos sintéticos de notificación
// (evita depender de archivos .mp3 que puedan fallar en la carga local).

export function createAudioContext() {
  return new (window.AudioContext || window.webkitAudioContext)();
}

// Reproduce un tono simple. `at` es el offset en segundos desde ahora.
// Devuelve el gainNode por si el llamador necesita programarle un fade-out.
export function playTone(ctx, { freq, type = 'sine', gain = 0.15, at = 0, duration }) {
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.connect(gainNode);
  gainNode.connect(ctx.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime + at);
  gainNode.gain.setValueAtTime(gain, ctx.currentTime + at);
  osc.start(ctx.currentTime + at);
  osc.stop(ctx.currentTime + at + duration);
  return gainNode;
}
