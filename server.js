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
        text: `STREAMLY PASS — Электронный билет\nФильм: ${ticket.movie}\nКинотеатр: ${ticket.cinema}\nДата: ${ticket.date}\nВремя сеанса: ${ticket.time}\nМеста: ${ticket.seats.join(", ")}\nСтоимость: €${Number(ticket.total || 0).toFixed(2)}\nНомер билета: ${id}\nПокажите QR-код при входе.\nОткрыть билет на сайте: ${ticketUrl}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:26px;background:#f8fafc;color:#1f2937;border:1px solid #e2e8f0;border-radius:20px"><div style="letter-spacing:.15em;color:#64748b;font-size:12px;font-weight:bold">STREAMLY PASS · ЭЛЕКТРОННЫЙ БИЛЕТ</div><h1 style="margin:12px 0;color:#111827;font-size:28px">${esc(ticket.movie)}</h1><p style="color:#64748b;margin-top:0">Ваш билет в кино готов. Сохраните письмо и покажите QR-код при входе.</p><div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px"><p style="margin:6px 0"><span style="color:#64748b">Кинотеатр</span><br><b>${esc(ticket.cinema)}</b></p><p style="margin:14px 0 6px"><span style="color:#64748b">Дата сеанса</span><br><b>${esc(ticket.date)}</b></p><p style="margin:14px 0 6px"><span style="color:#64748b">Время</span><br><b>${esc(ticket.time)}</b></p><p style="margin:14px 0 6px"><span style="color:#64748b">Места</span><br><b>${esc(ticket.seats.join(", "))}</b></p><p style="margin:14px 0 6px"><span style="color:#64748b">Стоимость</span><br><b>€${Number(ticket.total || 0).toFixed(2)}</b></p><p style="margin:14px 0 0"><span style="color:#64748b">Номер билета</span><br><b>${esc(id)}</b></p></div><div style="text-align:center;margin:22px 0 12px"><div style="display:inline-block;background:#fff;border:1px solid #e2e8f0;padding:12px;border-radius:16px"><img src="cid:ticketqr" width="240" height="240" alt="QR-код билета" style="display:block"></div><p style="color:#64748b;font-size:13px">QR-код для входа в кинотеатр</p></div><p style="text-align:center"><a href="${ticketUrl}" style="display:inline-block;background:#111827;color:#fff;padding:13px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Открыть билет на сайте</a></p></div>`,
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
  res.send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Streamly Pass — ${esc(t.movie)}</title><body style="margin:0;background:#eef2f7;color:#1f2937;font-family:Arial,sans-serif;display:grid;min-height:100vh;place-items:center;padding:18px;box-sizing:border-box"><main style="box-sizing:border-box;width:min(600px,100%);background:#fff;border:1px solid #e2e8f0;border-radius:24px;padding:clamp(20px,5vw,34px);box-shadow:0 18px 55px #0f172a14"><div style="letter-spacing:.18em;color:#64748b;font-size:12px;font-weight:bold">STREAMLY PASS · ЭЛЕКТРОННЫЙ БИЛЕТ</div><span style="display:inline-block;margin-top:16px;background:#dcfce7;color:#166534;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:bold">БИЛЕТ АКТИВЕН</span><h1 style="font-size:clamp(26px,6vw,34px);margin:14px 0 8px;color:#111827">${esc(t.movie)}</h1><p style="color:#64748b;margin-top:0">Покажите QR-код при входе в кинотеатр.</p><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:18px"><div><small style="color:#64748b">КИНОТЕАТР</small><div style="font-weight:bold;margin-top:5px">${esc(t.cinema)}</div></div><div><small style="color:#64748b">ДАТА</small><div style="font-weight:bold;margin-top:5px">${esc(t.date)}</div></div><div><small style="color:#64748b">ВРЕМЯ СЕАНСА</small><div style="font-weight:bold;margin-top:5px">${esc(t.time)}</div></div><div><small style="color:#64748b">МЕСТА</small><div style="font-weight:bold;margin-top:5px">${esc(t.seats.join(", "))}</div></div><div><small style="color:#64748b">СТОИМОСТЬ</small><div style="font-weight:bold;margin-top:5px">€${Number(t.total || 0).toFixed(2)}</div></div><div><small style="color:#64748b">НОМЕР БИЛЕТА</small><div style="font-weight:bold;margin-top:5px;overflow-wrap:anywhere">${esc(t.id)}</div></div></div><div style="text-align:center;margin:24px 0"><img src="/api/ticket/${encodeURIComponent(t.id)}/qr" alt="QR-код билета" style="width:260px;max-width:90%;box-sizing:border-box;background:#fff;border:1px solid #e2e8f0;padding:12px;border-radius:18px"><div style="color:#64748b;font-size:13px;margin-top:8px">QR-код для входа</div></div><button onclick="window.print()" style="display:block;margin:auto;border:0;border-radius:10px;padding:13px 20px;background:#111827;color:#fff;font-weight:bold;cursor:pointer">Печать билета</button></main></body></html>`);
});

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "streamly_cinema_redesign.html")));
app.listen(PORT, () => console.log(`Streamly Cinema запущен: http://localhost:${PORT}`));
