'use strict';

// Actualización a distancia: el admin deja una orden en la API ("actualizate a
// la versión X de main") y la API la devuelve en la respuesta del latido
// (lib/device-heartbeat.js). Este módulo la ejecuta con el mismo update del
// botón de /configuracion (blue-green, conserva el .env) y le cuenta a la API
// cómo va en el próximo latido.
//
//   init({ requestUpdate, cancelUpdate, isBusy })  → los de lib/configuracion.js;
//                                      isBusy(): true si hay una charla en curso
//   handle(order)                    → order = { id, version, branch } de la respuesta del latido
//   cancel(id)                       → el admin la canceló (respuesta del latido { cancelUpdate: id })
//   report()                         → { id, state, error } para mandar en el latido (o null)
//
// Cada orden se ejecuta una sola vez (por id): si falla no se reintenta sola,
// el admin la vuelve a pedir. Nunca actualiza en medio de una charla.

// Canal de la orden: main = estable, dev = pruebas. Cualquier otra cosa → main.
const CHANNELS = ['main', 'dev'];
const WAIT_POLL_MS = 5000;

let _requestUpdate = null;
let _cancelUpdate = () => false;
let _isBusy = () => false;
let _order = null;          // { id, version } de la última orden recibida
let _state = 'idle';        // idle | waiting | updating | failed | cancelled
let _error = null;

function init({ requestUpdate, cancelUpdate, isBusy }) {
  _requestUpdate = requestUpdate;
  if (cancelUpdate) _cancelUpdate = cancelUpdate;
  if (isBusy) _isBusy = isBusy;
}

function report() {
  return _order && _state !== 'idle' ? { id: _order.id, state: _state, error: _error } : null;
}

async function _run(order) {
  if (order !== _order || _state === 'cancelled') return;   // otra orden, o la cancelaron mientras esperaba
  if (_isBusy()) {
    _state = 'waiting';
    setTimeout(() => _run(order), WAIT_POLL_MS);
    return;
  }
  _state = 'updating';
  console.log(`[remote-update] instalando ${order.branch} @ ${order.version.slice(0, 7)} (pedido desde el admin)…`);
  const r = await _requestUpdate({ branch: order.branch, commit: order.version });
  if (r && r.ok && r.restarting) return;           // se reinicia con la versión nueva
  if (r && r.ok) { _state = 'idle'; return; }       // ya estaba en esa versión
  if (r && r.cancelled) { _state = 'cancelled'; _error = null; return; }
  _state = 'failed';
  _error = (r && r.error) || 'Error desconocido';
  console.error(`[remote-update] falló la actualización a ${order.version.slice(0, 7)}: ${_error}`);
}

function handle(order) {
  if (!_requestUpdate || !order || typeof order.version !== 'string' || !order.id) return;
  if (_order && _order.id === String(order.id)) return;   // ya la tomé
  if (_state === 'updating') return;                       // terminar la que está en curso primero
  _order = { id: String(order.id), version: order.version, branch: CHANNELS.includes(order.branch) ? order.branch : 'main' };
  _state = 'waiting';
  _error = null;
  void _run(_order);
}

function cancel(id) {
  if (!_order || _order.id !== String(id)) return;
  if (_state === 'waiting') { _state = 'cancelled'; console.log('[remote-update] el admin canceló la actualización antes de empezar'); }
  else if (_state === 'updating') _cancelUpdate();         // _run la marca como cancelled al volver
}

module.exports = { init, handle, cancel, report };
