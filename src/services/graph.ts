import { pool } from '../db.js';

type Edge = { to: string; km: number };

export function dijkstra(graph: Map<string, Edge[]>, start: string, end: string) {
  const dist = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();

  while (true) {
    let current: string | null = null;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (!done.has(node) && d < best) {
        best = d;
        current = node;
      }
    }
    if (current === null) return null; // pas de chemin
    if (current === end) break;
    done.add(current);
    for (const e of graph.get(current) ?? []) {
      const nd = best + e.km;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, current);
      }
    }
  }

  const path = [end];
  while (path[0] !== start) path.unshift(prev.get(path[0])!);
  return { km: Math.round((dist.get(end) ?? 0) * 10) / 10, path };
}

export async function cheminMaritime(depart: string, arrivee: string) {
  const { rows } = await pool.query(
    `SELECT "fromPlace" AS a, "toPlace" AS b, "distanceKm"::float AS km FROM sea_legs`
  );
  const graph = new Map<string, Edge[]>();
  const add = (a: string, b: string, km: number) =>
    graph.set(a, [...(graph.get(a) ?? []), { to: b, km }]);
  for (const r of rows) {
    add(r.a, r.b, r.km);
    add(r.b, r.a, r.km); // tronçons dans les deux sens
  }
  const res = dijkstra(graph, depart, arrivee);
  return res ?? { erreur: 'Aucun chemin entre ces deux ports' };
}