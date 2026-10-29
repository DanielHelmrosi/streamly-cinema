require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, "tickets.json");
let tickets = new Map();

function loadTickets() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    tickets = new Map(Object.entries(data));
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Could not load tickets:", err.message);
    tickets = new Map();
  }
}
function saveTickets() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(tickets), null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}
loadTickets();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname, { index: false }));

function smtpConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}
function createTransporter() {
  return nodemailer.createTransport({
    host: String(process.env.SMTP_HOST || "smtp.gmail.com").trim(),
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").trim().toLowerCase() === "true",
    auth: {
      user: String(process.env.SMTP_USER || "").trim(),
      pass: String(process.env.SMTP_PASS || "").replace(/\s+/g, "")
    },
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 15000
  });
}
function baseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return configured || `${req.protocol}://${req.get("host")}`;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function validTicketInput(body) {
  return body && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email || "")) &&
    body.id && body.movie && body.cinema && body.date && body.time &&
    Array.isArray(body.seats) && body.seats.length > 0;
}

app.get("/api/health", (_, res) => res.json({ ok: true, smtpConfigured: smtpConfigured(), ticketCount: tickets.size }));

app.post("/api/send-ticket", async (req, res) => {
  if (!validTicketInput(req.body)) return res.status(400).json({ ok: false, error: "Проверьте e-mail и все данные билета." });
  const { email, movie, cinema, date, time } = req.body;
  const id = String(req.body.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!id) return res.status(400).json({ ok: false, error: "Некорректный номер билета." });

  const ticket = {
    id, email: String(email).trim(), movie: String(movie).slice(0, 200),
    cinema: String(cinema).slice(0, 200), date: String(date).slice(0, 40),
    time: String(time).slice(0, 40), seats: req.body.seats.map(s => String(s).slice(0, 20)),
    createdAt: Date.now()
  };
  tickets.set(id, ticket);
  try { saveTickets(); } catch (err) {
    console.error("Ticket save error:", err.message);
    tickets.delete(id);
    return res.status(500).json({ ok: false, error: "Не удалось сохранить билет на сервере." });
  }

  const base = baseUrl(req);
  const ticketUrl = `${base}/ticket/${encodeURIComponent(id)}`;
  const qrUrl = `${base}/api/ticket/${encodeURIComponent(id)}/qr`;
  let emailSent = false;
  let emailError = "";

  // The ticket is saved and visible on the website even if SMTP is not configured.
  // Configure SMTP variables in .env to send the same QR code to the customer's email.
  if (smtpConfigured()) {
    try {
      const qr = await QRCode.toBuffer(ticketUrl, { type: "png", width: 420, margin: 2 });
      const transporter = createTransporter();
      await transporter.sendMail({
        from: process.env.MAIL_FROM || `Streamly Cinema <${String(process.env.SMTP_USER).trim()}>`,
        to: ticket.email,
        subject: `Streamly — QR-билет: ${ticket.movie}`,
        text: `Streamly Pass\n${ticket.movie}\n${ticket.cinema}\n${ticket.date} ${ticket.time}\nМеста: ${ticket.seats.join(", ")}\nНомер билета: ${id}\nОткрыть билет: ${ticketUrl}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;background:#111;color:#fff;border-radius:18px"><div style="letter-spacing:.15em;color:#aaa">STREAMLY PASS</div><h1>${esc(ticket.movie)}</h1><p>${esc(ticket.cinema)}<br>${esc(ticket.date)} · ${esc(ticket.time)}<br>Места: <b>${esc(ticket.seats.join(", "))}</b></p><div style="display:inline-block;background:#fff;padding:12px;border-radius:16px"><img src="cid:ticketqr" width="260" height="260" alt="QR-код билета"></div><p>Номер билета: <b>${esc(id)}</b></p><p><a href="${ticketUrl}" style="background:#fff;color:#000;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Открыть билет на сайте</a></p></div>`,
        attachments: [{ filename: `streamly-ticket-${id}-qr.png`, content: qr, contentType: "image/png", cid: "ticketqr" }]
      });
      emailSent = true;
    } catch (err) {
      console.error("SEND MAIL ERROR:", err.code, err.message);
      emailError = err.code === "EAUTH"
        ? "Gmail не принял пароль. Используйте пароль приложения Google."
        : "Билет сохранён на сайте, но письмо не отправилось. Проверьте настройки SMTP.";
    }
  } else {
    emailError = "Билет сохранён на сайте. Чтобы отправлять QR на почту, настройте SMTP в файле .env.";
  }

  return res.json({ ok: true, emailSent, emailError, ticketUrl, qrUrl, ticket: { ...ticket, ticketUrl, qrUrl } });
});

app.get("/api/ticket/:id/qr", async (req, res) => {
  const ticket = tickets.get(req.params.id);
  if (!ticket) return res.status(404).send("Билет не найден");
  try {
    const png = await QRCode.toBuffer(`${baseUrl(req)}/ticket/${encodeURIComponent(ticket.id)}`, { type: "png", width: 420, margin: 2 });
    res.set("Cache-Control", "no-store").type("png").send(png);
  } catch (err) { res.status(500).send("Не удалось создать QR-код"); }
});

app.get("/ticket/:id", (req, res) => {
  const t = tickets.get(req.params.id);
  if (!t) return res.status(404).send("<!doctype html><meta charset='utf-8'><title>Билет не найден</title><h1>Билет не найден</h1><p>Проверьте ссылку или оформите билет заново.</p>");
  res.send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Streamly Pass</title><body style="margin:0;background:#090909;color:#fff;font-family:Arial,sans-serif;display:grid;min-height:100vh;place-items:center"><main style="box-sizing:border-box;width:min(520px,92%);background:radial-gradient(ellipse at 100% 0%,#333,transparent 45%),linear-gradient(145deg,#202020,#0c0c0c);border:1px solid #454545;border-radius:24px;padding:30px;text-align:center;box-shadow:0 24px 80px #0009"><div style="letter-spacing:.18em;color:#aaa;font-size:12px">STREAMLY PASS</div><h1>${esc(t.movie)}</h1><p>${esc(t.cinema)}<br>${esc(t.date)} · ${esc(t.time)}<br>Места: <b>${esc(t.seats.join(", "))}</b></p><img src="/api/ticket/${encodeURIComponent(t.id)}/qr" alt="QR-код билета" style="width:260px;max-width:90%;box-sizing:border-box;background:#fff;padding:14px;border-radius:18px;box-shadow:0 10px 35px #0008"><p>Номер билета: <b>${esc(t.id)}</b></p><button onclick="window.print()" style="border:0;border-radius:10px;padding:12px 18px;font-weight:bold;cursor:pointer">Печать билета</button></main></body></html>`);
});

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "streamly_cinema_redesign.html")));
app.listen(PORT, () => console.log(`Streamly Cinema запущен: http://localhost:${PORT}`));
