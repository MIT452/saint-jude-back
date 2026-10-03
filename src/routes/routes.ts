import { Router } from 'express';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { start, destination } = req.body;

    if (!start || !destination) {
      return res.status(400).json({
        error: 'start et destination sont obligatoires',
      });
    }

    if (
      typeof start.latitude !== 'number' ||
      typeof start.longitude !== 'number' ||
      typeof destination.latitude !== 'number' ||
      typeof destination.longitude !== 'number'
    ) {
      return res.status(400).json({
        error: 'Les coordonnées doivent être numériques',
      });
    }

    if (
      start.latitude < -90 ||
      start.latitude > 90 ||
      destination.latitude < -90 ||
      destination.latitude > 90
    ) {
      return res.status(400).json({
        error: 'Latitude invalide',
      });
    }

    if (
      start.longitude < -180 ||
      start.longitude > 180 ||
      destination.longitude < -180 ||
      destination.longitude > 180
    ) {
      return res.status(400).json({
        error: 'Longitude invalide',
      });
    }

    // OSRM attend longitude,latitude
    const coordinates =
      `${start.longitude},${start.latitude};` +
      `${destination.longitude},${destination.latitude}`;

    const url =
      `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
      `?overview=full&geometries=geojson`;

    console.log('🗺️ Appel OSRM :', url);

    const response = await fetch(url);

    if (!response.ok) {
      return res.status(502).json({
        error: `OSRM HTTP ${response.status}`,
      });
    }

    const data = await response.json();

    if (data.code !== 'Ok' || !data.routes?.length) {
      return res.status(400).json({
        error: data.code ?? 'Route introuvable',
      });
    }

    const route = data.routes[0];

    return res.json({
      success: true,
      distance_m: route.distance,
      distance_km: Number((route.distance / 1000).toFixed(2)),
      duration_s: route.duration,
      duration_min: Number((route.duration / 60).toFixed(1)),
      geometry: route.geometry,
    });
  } catch (error) {
    console.error('❌ Erreur OSRM :', error);

    return res.status(500).json({
      error: 'Erreur lors du calcul de la route',
    });
  }
});

export default router;