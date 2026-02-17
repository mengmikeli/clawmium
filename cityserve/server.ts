import path from "path";
import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

import authRouter from "./api/auth";
import servicesRouter from "./api/services";
import waterBillRouter from "./api/water-bill";
import accountRouter from "./api/account";
import vehicleRouter from "./api/vehicle";
import parksRouter from "./api/parks";
import reportsRouter from "./api/reports";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const COOKIE_SECRET = process.env.COOKIE_SECRET || "cityserve-dev-secret";

// ---------- Middleware ----------

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(COOKIE_SECRET));

// Static files
app.use(express.static(path.join(__dirname, "public")));

// ---------- API Routes ----------

app.use("/api", authRouter);
app.use("/api", servicesRouter);
app.use("/api", waterBillRouter);
app.use("/api", accountRouter);
app.use("/api", vehicleRouter);
app.use("/api", parksRouter);
app.use("/api", reportsRouter);

// ---------- Start ----------

app.listen(PORT, () => {
  console.log(`\n  CityServe running at http://localhost:${PORT}\n`);
});
