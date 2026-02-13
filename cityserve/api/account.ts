import { Router, Request, Response } from "express";
import { requireAuth } from "./auth";
import { mockUser } from "../data/fixtures";

const router = Router();

/** GET /api/account — auth required */
router.get("/account", requireAuth, (_req: Request, res: Response): void => {
  res.json(mockUser.profile);
});

export default router;
