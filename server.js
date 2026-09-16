const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB = path.join(__dirname, 'tickets.json');
app.use(express.json({limit:'1mb'}));
app.use(express.static(__dirname));

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const readTickets = () => { try { return JSON.parse(fs.readFileSync(DB,'utf8')); } catch { return {}; } };
const writeTickets = x => fs.writeFileSync(DB, JSON.stringify(x,null,2));
const baseUrl = req => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/,'');

async function sendEmailViaResend({to, subject, html, qrBuffer}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Streamly <onboarding@resend.dev>';
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        attachments: [{
          filename: 'streamly-qr.png',
          content: qrBuffer.toString('base64'),
          content_id: 'streamly-ticket-qr'
        }]
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Resend ${response.status}: ${data.message || JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}


function ticketCard(t, ticketUrl, qrSrc='cid:streamly-ticket-qr'){
  return `<div style="margin:0 auto;max-width:620px;background:#08080a;color:#fff;border:1px solid #2b2b31;border-radius:28px;overflow:hidden;font-family:Arial,sans-serif">
    <div style="padding:28px 30px;background:linear-gradient(135deg,#1d1d22,#09090b)">
      <div style="font-size:12px;letter-spacing:4px;color:#9b9ba3">STREAMLY PASS</div>
      <div style="display:inline-block;margin-top:14px;padding:7px 11px;border-radius:999px;background:#fff;color:#09090b;font-size:11px;font-weight:800">БЕЗ ОПЛАТЫ</div>
      <h1 style="font-size:30px;line-height:1.1;margin:18px 0 8px">${esc(t.movie)}</h1>
      <div style="color:#a9a9b2">${esc(t.cinema)}</div>
    </div>
    <div style="padding:28px 30px">
      <table width="100%" cellpadding="0" cellspacing="0" style="color:#fff"><tr>
        <td style="vertical-align:top"><div style="color:#777781;font-size:11px">ДАТА</div><b>${esc(t.date)}</b><div style="height:18px"></div><div style="color:#777781;font-size:11px">ВРЕМЯ</div><b style="font-size:25px">${esc(t.time)}</b><div style="height:18px"></div><div style="color:#777781;font-size:11px">МЕСТА</div><b style="font-size:22px">${esc((t.seats||[]).join(', '))}</b></td>
        <td width="220" align="right"><div style="background:#fff;padding:12px;border-radius:18px;display:inline-block"><img src="${qrSrc}" width="190" height="190" alt="QR"></div></td>
      </tr></table>
      <div style="margin-top:25px;padding-top:20px;border-top:1px dashed #3a3a40;color:#888891;font-size:12px">Билет ${esc(t.id)} · Покажите QR-код при входе. При сканировании откроется защищённая страница билета Streamly.</div>
      <div style="margin-top:18px"><a href="${esc(ticketUrl)}" style="display:inline-block;background:#fff;color:#08080a;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700">Открыть билет</a></div>
    </div></div>`;
}

app.post('/api/send-ticket', async (req,res)=>{
  try{
    const t=req.body;
    if(!t.email || !t.id || !t.movie || !Array.isArray(t.seats)) return res.status(400).json({ok:false,error:'invalid_ticket'});
    const tickets=readTickets();
    tickets[t.id]={...t,createdAt:new Date().toISOString()}; writeTickets(tickets);
    const ticketUrl=`${baseUrl(req)}/ticket/${encodeURIComponent(t.id)}`;
    const qrBuffer=await QRCode.toBuffer(ticketUrl,{width:520,margin:2,errorCorrectionLevel:'M'});
    const mail = await sendEmailViaResend({
      to: t.email,
      subject: `Streamly — билет на ${t.movie}`,
      html: ticketCard(t, ticketUrl),
      qrBuffer
    });
    console.log('EMAIL SENT', { id: mail.id, to: t.email, ticket: t.id });
    res.json({ok:true,ticketUrl,qrUrl:`/api/ticket/${encodeURIComponent(t.id)}/qr`,emailId:mail.id});
  } catch(e){
    console.error('SEND TICKET ERROR:', e?.name, e?.message);
    const timeout = e?.name === 'AbortError';
    res.status(timeout ? 504 : 500).json({ok:false,error:timeout ? 'email_timeout' : 'send_failed'});
  }
});

app.get('/api/ticket/:id/qr', async (req,res)=>{
  const t=readTickets()[req.params.id]; if(!t) return res.status(404).send('Not found');
  const url=`${baseUrl(req)}/ticket/${encodeURIComponent(req.params.id)}`;
  res.type('png').send(await QRCode.toBuffer(url,{width:520,margin:2,errorCorrectionLevel:'M'}));
});

app.get('/ticket/:id', async (req,res)=>{
  const t=readTickets()[req.params.id];
  if(!t) return res.status(404).send('<h1>Билет не найден</h1>');
  const ticketUrl=`${baseUrl(req)}/ticket/${encodeURIComponent(t.id)}`;
  const qr=await QRCode.toDataURL(ticketUrl,{width:520,margin:2,errorCorrectionLevel:'M'});
  res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Streamly Pass — ${esc(t.movie)}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:radial-gradient(circle at top,#24242b 0,#0b0b0e 42%,#050506 100%);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff}.wrap{width:min(620px,100%)}.status{display:flex;align-items:center;gap:9px;margin:0 0 12px;color:#b8f5c9;font-size:13px}.dot{width:9px;height:9px;border-radius:50%;background:#6ee79a;box-shadow:0 0 18px #6ee79a}.ticket{border:1px solid #34343c;border-radius:28px;overflow:hidden;background:#0b0b0e;box-shadow:0 30px 100px #000}.top{padding:28px;background:linear-gradient(135deg,#25252c,#101014)}.brand{letter-spacing:4px;color:#9b9ba4;font-size:12px}.free{display:inline-block;margin-top:14px;background:#fff;color:#09090b;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:900}.top h1{font-size:32px;line-height:1.05;margin:18px 0 8px}.muted{color:#a0a0aa}.body{padding:28px}.grid{display:grid;grid-template-columns:1fr 210px;gap:25px}.label{font-size:10px;letter-spacing:1.4px;color:#74747d;margin-top:17px}.value{font-size:20px;font-weight:750;margin-top:4px}.time,.seats{font-size:34px}.qr{background:#fff;border-radius:20px;padding:12px;width:210px;height:210px}.qr img{width:100%;height:100%}.tear{border-top:1px dashed #3b3b43;margin:26px 0 20px}.code{font-family:ui-monospace,monospace;color:#8b8b94;font-size:12px}.hint{color:#8b8b94;font-size:12px;line-height:1.55;margin-top:12px}@media(max-width:540px){.grid{grid-template-columns:1fr}.qr{width:100%;height:auto;aspect-ratio:1}.top h1{font-size:27px}.body,.top{padding:22px}}</style></head><body><main class="wrap"><div class="status"><i class="dot"></i> Билет действителен</div><article class="ticket"><section class="top"><div class="brand">STREAMLY PASS</div><span class="free">БЕЗ ОПЛАТЫ</span><h1>${esc(t.movie)}</h1><div class="muted">${esc(t.cinema)}</div></section><section class="body"><div class="grid"><div><div class="label">ДАТА</div><div class="value">${esc(t.date)}</div><div class="label">ВРЕМЯ</div><div class="value time">${esc(t.time)}</div><div class="label">РЯД · МЕСТО</div><div class="value seats">${esc((t.seats||[]).join(' · '))}</div></div><div class="qr"><img src="${qr}" alt="QR"></div></div><div class="tear"></div><div class="code">${esc(t.id)}</div><div class="hint">Покажите эту страницу или QR-код сотруднику кинотеатра при входе в зал. Электронный билет оформлен в Streamly.</div></section></article></main></body></html>`);
});

app.get('/',(_,res)=>res.sendFile(path.join(__dirname,'streamly_cinema_redesign.html')));
app.listen(PORT,()=>console.log(`Streamly: http://localhost:${PORT}`));
