import { pool } from '../db.js';
import { distanceEntre, routeTerrestre } from '../services/geo.js';
import { meteoPour } from '../services/weather.js';
import { cheminMaritime } from '../services/graph.js';
import { prevoirCarburant } from '../services/ml.js';

type Args = Record<string, unknown>;
type Tool = {
  def: { type: 'function'; function: { name: string; description: string; parameters: object } };
  run: (a: Args) => Promise<unknown>;
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
const lim = (v: unknown, d = 10) => Math.min(Math.max(Number(v) || d, 1), 50);

export const tools: Record<string, Tool> = {};

function define(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: (a: Args) => Promise<unknown>
) {
  tools[name] = {
    def: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } },
    run,
  };
}

define('lister_bateaux', 'Liste les bateaux, filtrables par état', { etat: { type: 'string' } }, [], async (a) => {
  const { rows } = await pool.query(
    `SELECT id, name, capacity, state FROM boats WHERE ($1::text IS NULL OR state = $1) LIMIT 50`,
    [str(a.etat)]
  );
  return rows;
});

define(
  'lister_trajets',
  'Liste les trajets récents, filtrables par statut',
  { statut: { type: 'string' }, limite: { type: 'integer' } },
  [],
  async (a) => {
    const { rows } = await pool.query(
      `SELECT id, "boatId", "from", "to", depart, arrive, status FROM trips
       WHERE ($1::text IS NULL OR status = $1) ORDER BY depart DESC LIMIT $2`,
      [str(a.statut), lim(a.limite)]
    );
    return rows;
  }
);

define('resume_caisse', 'Total des crédits, débits et solde de la caisse', {}, [], async () => {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(credit),0)::float AS credit, COALESCE(SUM(debit),0)::float AS debit FROM cashmovements`
  );
  const r = rows[0];
  return { ...r, solde: r.credit - r.debit };
});

define('reservations_impayees', 'Nombre et montant des réservations non payées', {}, [], async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS nombre, COALESCE(SUM("amountToPay"),0)::float AS montant
     FROM reservations WHERE "paymentStatus" = false`
  );
  return rows[0];
});

define(
  'carburant_trajet',
  "Litres et coût du carburant d'un trajet",
  { tripId: { type: 'string' } },
  ['tripId'],
  async (a) => {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(quantity),0)::float AS litres, COALESCE(SUM(cost),0)::float AS cout
       FROM fuelconsumptions WHERE "tripId" = $1`,
      [str(a.tripId)]
    );
    return rows[0];
  }
);

define(
  'marchandises_trajet',
  "Nombre d'articles, poids total et prix total des marchandises d'un trajet",
  { tripId: { type: 'string' } },
  ['tripId'],
  async (a) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS articles, COALESCE(SUM("totalWeight"),0)::float AS poids,
              COALESCE(SUM("totalPrice"),0)::float AS prix
       FROM goods WHERE "tripId" = $1`,
      [str(a.tripId)]
    );
    return rows[0];
  }
);

define(
  'derniere_position',
  "Dernière position GPS d'un bateau",
  { boatId: { type: 'string' } },
  ['boatId'],
  async (a) => {
    const { rows } = await pool.query(
      `SELECT latitude::float AS latitude, longitude::float AS longitude, speed::float AS speed, "createdAt"
       FROM positions WHERE "boatId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [str(a.boatId)]
    );
    return rows[0] ?? { erreur: 'Aucune position enregistrée' };
  }
);

define('meteo', "Météo et état de la mer d'un lieu de la table places", { lieu: { type: 'string' } }, ['lieu'], (a) =>
  meteoPour(str(a.lieu) ?? '')
);

define(
  'distance',
  'Distance en ligne droite et durée estimée entre deux lieux',
  { depart: { type: 'string' }, arrivee: { type: 'string' } },
  ['depart', 'arrivee'],
  (a) => distanceEntre(str(a.depart) ?? '', str(a.arrivee) ?? '')
);

define(
  'itineraire_routier',
  'Distance et durée par la route entre deux lieux',
  { depart: { type: 'string' }, arrivee: { type: 'string' } },
  ['depart', 'arrivee'],
  (a) => routeTerrestre(str(a.depart) ?? '', str(a.arrivee) ?? '')
);

define(
  'chemin_maritime',
  'Plus court chemin maritime entre deux ports',
  { depart: { type: 'string' }, arrivee: { type: 'string' } },
  ['depart', 'arrivee'],
  (a) => cheminMaritime(str(a.depart) ?? '', str(a.arrivee) ?? '')
);

define(
  'prevoir_carburant',
  "Prévision des litres de carburant selon le poids des marchandises et le nombre de réservations",
  { poidsKg: { type: 'number' }, nbReservations: { type: 'number' } },
  ['poidsKg', 'nbReservations'],
  (a) => prevoirCarburant(Number(a.poidsKg) || 0, Number(a.nbReservations) || 0)
);

export const toolDefs = Object.values(tools).map((t) => t.def);