const express=require('express');
const nodemailer=require('nodemailer');
const QRCode=require('qrcode');
const path=require('path');
const fs=require('fs');
require('dotenv').config();

const app=express();
const PORT=Number(process.env.PORT||3000);
const DB=path.join(__dirname,'tickets.json');
const LIFE=10*60*1000;
app.use(express.json({limit:'1mb'}));
app.use(express.static(__dirname));

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const readTickets=()=>{try{return JSON.parse(fs.readFileSync(DB,'utf8'))}catch{return {}}};
const writeTickets=x=>fs.writeFileSync(DB,JSON.stringify(x,null,2));
const baseUrl=req=>(process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`).replace(/\/+$/,'');
const expired=t=>!t?.expiresAt||Date.now()>=Date.parse(t.expiresAt);

const mailer=nodemailer.createTransport({
  host:process.env.SMTP_HOST||'smtp.gmail.com',
  port:Number(process.env.SMTP_PORT||587),
  secure:String(process.env.SMTP_SECURE||'false').toLowerCase()==='true',
  auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}
});

function emailHtml(t,url){
 return `<!doctype html><html><body style="margin:0;padding:24px;background:#eee;font-family:Arial">
 <div style="max-width:620px;margin:auto;background:#0b0b0e;color:#fff;border-radius:24px;overflow:hidden">
 <div style="padding:28px;background:#19191f"><div style="letter-spacing:4px;color:#999;font-size:12px">STREAMLY PASS</div>
 <h1>${esc(t.movie)}</h1><div style="color:#aaa">${esc(t.cinema||'')}</div></div>
 <div style="padding:28px"><p><b>Дата:</b> ${esc(t.date||'')}</p><p><b>Время:</b> ${esc(t.time||'')}</p>
 <p><b>Места:</b> ${esc((t.seats||[]).join(', '))}</p><p><b>Код:</b> ${esc(t.id)}</p>
 <div style="background:#fff;padding:14px;border-radius:18px;width:260px;max-width:90%;margin:24px 0">
 <img src="cid:streamly-ticket-qr" style="display:block;width:100%" alt="QR-код"></div>
 <p style="color:#aaa">QR-код действует 10 минут с момента создания билета.</p>
 <a href="${esc(url)}" style="display:inline-block;background:#fff;color:#000;text-decoration:none;padding:13px 18px;border-radius:12px;font-weight:bold">Открыть билет</a>
 </div></div></body></html>`;
}

app.post('/api/send-ticket',async(req,res)=>{
 try{
  const t=req.body||{};
  if(!t.email||!t.id||!t.movie||!Array.isArray(t.seats)||!t.seats.length)
    return res.status(400).json({ok:false,error:'invalid_ticket'});
  if(!process.env.SMTP_USER||!process.env.SMTP_PASS) throw new Error('SMTP_USER / SMTP_PASS are not configured');

  const now=Date.now();
  const ticket={...t,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+LIFE).toISOString()};
  const tickets=readTickets(); tickets[ticket.id]=ticket; writeTickets(tickets);
  const url=`${baseUrl(req)}/ticket/${encodeURIComponent(ticket.id)}`;
  const qr=await QRCode.toBuffer(url,{width:600,margin:2,errorCorrectionLevel:'M'});

  const info=await mailer.sendMail({
   from:process.env.MAIL_FROM||`"Streamly" <${process.env.SMTP_USER}>`,
   to:ticket.email,
   subject:`Streamly — билет на ${ticket.movie}`,
   html:emailHtml(ticket,url),
   attachments:[{filename:'streamly-ticket-qr.png',content:qr,contentType:'image/png',cid:'streamly-ticket-qr'}]
  });
  console.log('EMAIL SENT',{messageId:info.messageId,to:ticket.email,ticket:ticket.id});
  res.json({ok:true,ticketUrl:url,qrUrl:`/api/ticket/${encodeURIComponent(ticket.id)}/qr`,expiresAt:ticket.expiresAt});
 }catch(e){
  console.error('SEND TICKET ERROR:',e.message);
  res.status(500).json({ok:false,error:'send_failed',message:e.message});
 }
});

app.get('/api/ticket/:id/qr',async(req,res)=>{
 const tickets=readTickets(),t=tickets[req.params.id];
 if(!t||expired(t)){if(t){delete tickets[req.params.id];writeTickets(tickets)}return res.status(410).send('Ticket expired')}
 const url=`${baseUrl(req)}/ticket/${encodeURIComponent(req.params.id)}`;
 res.type('png').send(await QRCode.toBuffer(url,{width:600,margin:2,errorCorrectionLevel:'M'}));
});

app.get('/ticket/:id',async(req,res)=>{
 const tickets=readTickets(),t=tickets[req.params.id];
 if(!t||expired(t)){if(t){delete tickets[req.params.id];writeTickets(tickets)}
  return res.status(410).send('<!doctype html><meta charset="utf-8"><body style="background:#08080a;color:white;font-family:Arial;text-align:center;padding-top:20vh"><h1>Билет больше не действует</h1><p>Срок действия QR-кода — 10 минут.</p></body>')}
 const url=`${baseUrl(req)}/ticket/${encodeURIComponent(t.id)}`;
 const qr=await QRCode.toDataURL(url,{width:600,margin:2,errorCorrectionLevel:'M'});
 const remain=Math.max(0,Date.parse(t.expiresAt)-Date.now());
 res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 <title>Streamly — ${esc(t.movie)}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#070709;color:#fff;font-family:Arial}.ticket{width:min(600px,100%);background:#111116;border:1px solid #333;border-radius:26px;overflow:hidden}.top,.body{padding:26px}.top{background:#1b1b21}.brand{letter-spacing:4px;color:#999;font-size:12px}.grid{display:grid;grid-template-columns:1fr 220px;gap:24px;align-items:center}.label{font-size:11px;color:#777;margin-top:15px}.value{font-size:22px;font-weight:bold}.qr{background:#fff;padding:12px;border-radius:18px}.qr img{display:block;width:100%}.timer{margin-top:22px;padding:13px;background:#202027;border-radius:12px}@media(max-width:560px){.grid{grid-template-columns:1fr}.qr{max-width:260px}}</style></head><body>
 <article class="ticket"><div class="top"><div class="brand">STREAMLY PASS</div><h1>${esc(t.movie)}</h1><div>${esc(t.cinema||'')}</div></div><div class="body"><div class="grid"><div>
 <div class="label">ДАТА</div><div class="value">${esc(t.date||'')}</div><div class="label">ВРЕМЯ</div><div class="value">${esc(t.time||'')}</div><div class="label">МЕСТА</div><div class="value">${esc((t.seats||[]).join(', '))}</div><div class="label">КОД</div><div>${esc(t.id)}</div>
 </div><div class="qr"><img src="${qr}"></div></div><div class="timer">Билет действует ещё: <b id="left"></b></div></div></article>
 <script>let left=${remain};const el=document.getElementById('left');function tick(){if(left<=0){location.reload();return}const s=Math.ceil(left/1000),m=Math.floor(s/60),r=s%60;el.textContent=m+':'+String(r).padStart(2,'0');left-=1000}tick();setInterval(tick,1000)</script></body></html>`);
});

app.get('/',(_,res)=>res.sendFile(path.join(__dirname,'streamly_cinema_redesign.html')));
app.listen(PORT,()=>console.log(`Streamly: http://localhost:${PORT}`));
