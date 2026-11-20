'use strict';

// Actualización a distancia: el admin deja una orden en la API ("actualizate a
// la versión X de main") y la API la devuelve en la respuesta del latido
// (lib/device-heartbeat.js). Este módulo la ejecuta con el mismo update del
// botón de /configuracion (blue-green, conserva el .env) y le cuenta a la API
// cómo va en el próximo latido.
//
//   init({ requestUpdate, isBusy })  → requestUpdate: el de lib/configuracion.js;
//                                      isBusy(): true si hay una charla en curso
//   handle(order)                    → order = { id, version } de la respuesta del latido
//   report()                         → { id, state, error } para mandar en el latido (o null)
//
// Cada orden se ejecuta una sola vez (por id): si falla no se reintenta sola,
// el admin la vuelve a pedir. Nunca actualiza en medio de una charla.

const BRANCH = 'main';      // desde el admin solo se instala main (dev es para probar en la Pi propia)
const WAIT_POLL_MS = 5000;

let _requestUpdate = null;
let _isBusy = () => false;
let _order = null;          // { id, version } de la última orden recibida
let _state = 'idle';        // idle | waiting | updating | failed
let _error = null;

function init({ requestUpdate, isBusy }) {
  _requestUpdate = requestUpdate;
  if (isBusy) _isBusy = isBusy;
}

function report() {
  return _order && _state !== 'idle' ? { id: _order.id, state: _state, error: _error } : null;
}

async function _run(order) {
  if (order !== _order) return;                     // llegó otra orden mientras esperaba
  if (_isBusy()) {
    _state = 'waiting';
    setTimeout(() => _run(order), WAIT_POLL_MS);
    return;
  }
  _state = 'updating';
  console.log(`[remote-update] instalando ${BRANCH} @ ${order.version.slice(0, 7)} (pedido desde el admin)…`);
  const r = await _requestUpdate({ branch: BRANCH, commit: order.version });
  if (r && r.ok && r.restarting) return;           // se reinicia con la versión nueva
  if (r && r.ok) { _state = 'idle'; return; }       // ya estaba en esa versión
  _state = 'failed';
  _error = (r && r.error) || 'Error desconocido';
  console.error(`[remote-update] falló la actualización a ${order.version.slice(0, 7)}: ${_error}`);
}

function handle(order) {
  if (!_requestUpdate || !order || typeof order.version !== 'string' || !order.id) return;
  if (_order && _order.id === order.id) return;    // ya la tomé
  if (_state === 'updating') return;               // terminar la que está en curso primero
  _order = { id: String(order.id), version: order.version };
  _state = 'waiting';
  _error = null;
  void _run(_order);
}

module.exports = { init, handle, report };
