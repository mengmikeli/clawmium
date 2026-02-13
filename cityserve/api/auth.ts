import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { mockUser, sessions } from "../data/fixtures";

const router = Router();

// ---------- Middleware ----------

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.signedCookies?.session_token;
  if (!token || !sessions.has(token)) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

// ---------- Routes ----------

/** POST /api/login */
router.post("/login", (req: Request, res: Response): void => {
  const { username, password } = req.body;

  if (username !== mockUser.username || password !== mockUser.password) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    token,
    username: mockUser.username,
    createdAt: Date.now(),
  });

  res.cookie("session_token", token, {
    httpOnly: true,
    signed: true,
    maxAge: 1000 * 60 * 60, // 1 hour
    sameSite: "lax",
  });

  res.json({
    success: true,
    user: {
      name: mockUser.profile.name,
      email: mockUser.profile.email,
    },
  });
});

/** GET /api/session */
router.get("/session", (req: Request, res: Response): void => {
  const token = req.signedCookies?.session_token;
  if (!token || !sessions.has(token)) {
    res.status(401).json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    user: {
      name: mockUser.profile.name,
      email: mockUser.profile.email,
    },
  });
});

/** POST /api/logout */
router.post("/logout", (req: Request, res: Response): void => {
  const token = req.signedCookies?.session_token;
  if (token) {
    sessions.delete(token);
  }
  res.clearCookie("session_token");
  res.json({ success: true });
});

export default router;
