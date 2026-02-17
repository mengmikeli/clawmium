import { Router, Request, Response } from "express";
import { requireAuth } from "./auth";
import { mockReports, reportCategories, IssueReport } from "../data/fixtures";

const router = Router();

/** Mutable reports array — POST adds to this */
const reports: IssueReport[] = [...mockReports];

/** GET /api/report-categories — category strings (auth required) */
router.get("/report-categories", requireAuth, (_req: Request, res: Response): void => {
  res.json(reportCategories);
});

/** GET /api/reports — user's reports (auth required) */
router.get("/reports", requireAuth, (_req: Request, res: Response): void => {
  res.json(reports);
});

/** POST /api/reports — create a new report (auth required) */
router.post("/reports", requireAuth, (req: Request, res: Response): void => {
  const { category, location, description } = req.body;

  if (!category || !location || !description) {
    res.status(400).json({ error: "Missing required fields: category, location, description" });
    return;
  }

  const now = new Date().toISOString();
  const id = "RPT-2026-" + String(reports.length + 1).padStart(3, "0");

  const report: IssueReport = {
    id,
    category,
    location,
    description,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };

  reports.push(report);
  res.status(201).json(report);
});

export default router;
