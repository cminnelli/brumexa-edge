'use strict';

/**
 * lib/route-list.js
 *
 * Lista las rutas HTTP registradas en la app de Express, leídas en vivo de
 * su router — así el listado de /endpoints nunca queda desactualizado
 * respecto del código (no es una lista mantenida a mano). Solo cubre rutas
 * registradas directo sobre `app` (app.get/post/...), que hoy son todas:
 * no se usa express.Router() en ningún lado.
 */

function listRoutes(app) {
  const routes = [];
  for (const layer of app._router?.stack || []) {
    if (!layer.route) continue; // middlewares (static, json, logger), no rutas
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const p of paths) {
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method === '_all' ? 'ALL' : method.toUpperCase(), path: String(p) });
      }
    }
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return routes;
}

module.exports = { listRoutes };
