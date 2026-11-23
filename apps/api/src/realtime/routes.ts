import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { issueWsTicket } from "./tickets.js";
import { wsPublicUrl } from "./ws-server.js";

const router = Router();

router.post("/ticket", requireAuth, (req, res) => {
  res.json({ url: wsPublicUrl("/ws/events"), ticket: issueWsTicket(req.user!.id) });
});

export default router;
