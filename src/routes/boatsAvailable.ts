import { Router } from "express";
import { pool } from "../db.js";

// Lecture seule des bateaux, champs publics uniquement (pas d'équipage).
// Monté derrière requireAuth dans server.ts.
const router = Router();

router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM boats`);
    const boats = rows
      .map((b: Record<string, unknown>) => ({
        id: b.id,
        name: b.name,
        capacity: b.capacity,
        state: b.state,
        image: b.image ?? "",
      }))
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    res.json(boats);
  } catch (e) {
    console.error("boats/available:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;