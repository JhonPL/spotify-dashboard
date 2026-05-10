/**
 * eventBus.js — Eventos globales entre gráficos (linked views)
 *
 * Desacopla los gráficos entre sí: ninguno importa a otro directamente.
 * Todos hablan a través de eventos nombrados.
 *
 * Eventos disponibles:
 *   genre:select      { genre: string }
 *   genre:hover       { genre: string | null }
 *   genre:clear       {}
 *   brush:update      { extent: [[x0,y0],[x1,y1]] | null, ids: Set<string> }
 *   feature:change    { axis: 'x'|'y', feature: string }
 *   artist:hover      { artist: string | null }
 *   view:change       { view: string }
 *   data:ready        { key: string }
 *   filters:clear     {}
 */

const _handlers = {};

/**
 * Suscribirse a un evento
 * @param {string} event
 * @param {Function} handler
 * @returns {Function} unsubscribe
 */
export function on(event, handler) {
  if (!_handlers[event]) _handlers[event] = [];
  _handlers[event].push(handler);
  return () => off(event, handler);
}

/**
 * Desuscribirse de un evento
 */
export function off(event, handler) {
  if (!_handlers[event]) return;
  _handlers[event] = _handlers[event].filter(h => h !== handler);
}

/**
 * Emitir un evento con payload
 */
export function emit(event, payload = {}) {
  (_handlers[event] || []).forEach(h => {
    try { h(payload); }
    catch (e) { console.error(`[eventBus] Error en handler de "${event}":`, e); }
  });
}

/**
 * Suscribirse a un evento una sola vez
 */
export function once(event, handler) {
  const unsub = on(event, (payload) => {
    handler(payload);
    unsub();
  });
  return unsub;
}

export default { on, off, emit, once };