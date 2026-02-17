import { Router, Request, Response } from "express";
import { requireAuth } from "./auth";
import { mockParks } from "../data/fixtures";

const router = Router();

/** GET /api/parks — all parks, auth required */
router.get("/parks", requireAuth, (_req: Request, res: Response): void => {
  res.json(mockParks);
});

/** GET /api/parks/:id — single park, auth required */
router.get("/parks/:id", requireAuth, (req: Request, res: Response): void => {
  const park = mockParks.find((p) => p.id === req.params.id);

  if (!park) {
    res.status(404).json({ error: "Park not found" });
    return;
  }

  res.json(park);
});

export default router;
