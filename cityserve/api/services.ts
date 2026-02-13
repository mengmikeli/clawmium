import { Router, Request, Response } from "express";
import { mockServices } from "../data/fixtures";

const router = Router();

/** GET /api/services — public, no auth required */
router.get("/services", (_req: Request, res: Response): void => {
  res.json(mockServices);
});

export default router;
