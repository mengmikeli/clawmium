import { Router, Request, Response } from "express";
import { requireAuth } from "./auth";
import { mockVehicles } from "../data/fixtures";

const router = Router();

/** GET /api/vehicle?plate=ABC1234 — auth required */
router.get("/vehicle", requireAuth, (req: Request, res: Response): void => {
  const plate = (req.query.plate as string || "").toUpperCase().trim();

  if (!plate) {
    res.status(400).json({ error: "Missing plate parameter" });
    return;
  }

  const vehicle = mockVehicles.find((v) => v.plate === plate);

  if (!vehicle) {
    res.status(404).json({ error: "No vehicle found for plate " + plate });
    return;
  }

  res.json(vehicle);
});

export default router;
