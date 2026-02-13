import { Router, Request, Response } from "express";
import { requireAuth } from "./auth";
import { mockWaterBill } from "../data/fixtures";

const router = Router();

/** GET /api/water-bill — auth required */
router.get("/water-bill", requireAuth, (_req: Request, res: Response): void => {
  res.json(mockWaterBill);
});

export default router;
