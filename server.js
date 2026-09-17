require("dotenv").config();
const express=require("express");
const nodemailer=require("nodemailer");
const QRCode=require("qrcode");
const path=require("path");

const app=express();
const PORT=Number(process.env.PORT||3000);
const LIFE=10*60*1000;
const tickets=new Map();

app.use(express.json({limit:"1mb"}));
app.use(express.static(__dirname));

const transporter=nodemailer.createTransport({
  host:process.env.SMTP_HOST||"smtp.gmail.com",
  port:Number(process.env.SMTP_PORT||587),
  secure:String(process.env.SMTP_SECURE||"false").toLowerCase()==="true",
  auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}
});

function publicBase(req){
  const configured=String(process.env.PUBLIC_BASE_URL||"").trim().replace(/\/+$/,"");
  return configured||`${req.protocol}://${req.get("host")}`;
}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function getTicket(id){
  const t=tickets.get(id);
  if(!t)return null;
  if(Date.now()>=t.expiresAt){tickets.delete(id);return null}
  return t;
}

app.post("/api/send-ticket",async(req,res)=>{
  try{
    const {email,id,movie,cinema,date,time,seats}=req.body||{};
    if(!email||!id||!movie||!cinema||!date||!time||!Array.isArray(seats)||!seats.length)
      return res.status(400).json({error:"Не заполнены данные билета"});

    const createdAt=Date.now(),expiresAt=createdAt+LIFE;
    const ticket={email,id,movie,cinema,date,time,seats,createdAt,expiresAt};
    tickets.set(id,ticket);

    const base=publicBase(req);
    const ticketUrl=`${base}/ticket/${encodeURIComponent(id)}`;
    const qrUrl=`${base}/api/ticket/${encodeURIComponent(id)}/qr`;
    const qrPng=await QRCode.toBuffer(ticketUrl,{type:"png",width:420,margin:2});

    const from=process.env.MAIL_FROM||`Streamly <${process.env.SMTP_USER}>`;
    await transporter.sendMail({
      from,to:email,
      subject:`Streamly — QR-билет: ${movie}`,
      text:`Ваш билет Streamly\n${movie}\n${cinema}\n${date} ${time}\nМеста: ${seats.join(", ")}\nКод: ${id}\nБилет действует 10 минут.\n${ticketUrl}`,
      html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;background:#111;color:#fff;border-radius:18px">
        <div style="font-size:13px;letter-spacing:.16em;color:#aaa">STREAMLY PASS</div>
        <h1 style="margin:12px 0">${esc(movie)}</h1>
        <p style="line-height:1.7;color:#ddd">${esc(cinema)}<br>${esc(date)} · ${esc(time)}<br>Места: <b>${esc(seats.join(", "))}</b></p>
        <div style="background:#fff;padding:14px;border-radius:16px;display:inline-block"><img src="cid:streamly-ticket-qr" width="260" height="260" alt="QR-билет"></div>
        <p>Код билета: <b>${esc(id)}</b></p>
        <p style="color:#ffcc66"><b>QR-билет действует 10 минут после оформления.</b></p>
        <p><a href="${ticketUrl}" style="display:inline-block;background:#fff;color:#000;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:bold">Открыть билет</a></p>
      </div>`,
      attachments:[{filename:"streamly-ticket-qr.png",content:qrPng,cid:"streamly-ticket-qr"}]
    });

    res.json({ok:true,ticketUrl,qrUrl,expiresAt:new Date(expiresAt).toISOString()});
  }catch(err){
    console.error("SEND MAIL ERROR:",err);
    res.status(500).json({error:"Не удалось отправить письмо. Проверьте SMTP в Render."});
  }
});

app.get("/api/ticket/:id/qr",async(req,res)=>{
  const t=getTicket(req.params.id);
  if(!t)return res.status(410).send("Билет не найден или срок действия истёк");
  try{
    const png=await QRCode.toBuffer(`${publicBase(req)}/ticket/${encodeURIComponent(t.id)}`,{type:"png",width:420,margin:2});
    res.type("png").send(png);
  }catch(e){res.status(500).send("QR error")}
});

app.get("/ticket/:id",(req,res)=>{
  const t=getTicket(req.params.id);
  if(!t)return res.status(410).send("<h1>Билет больше не действует</h1><p>Срок действия QR-билета истёк.</p>");
  res.send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Streamly Pass</title>
  <body style="margin:0;background:#090909;color:#fff;font-family:Arial,sans-serif;display:grid;min-height:100vh;place-items:center">
  <main style="width:min(520px,90%);background:#171717;border:1px solid #333;border-radius:22px;padding:28px;text-align:center">
  <div style="letter-spacing:.18em;color:#aaa;font-size:12px">STREAMLY PASS</div><h1>${esc(t.movie)}</h1>
  <p>${esc(t.cinema)}<br>${esc(t.date)} · ${esc(t.time)}<br>Места: <b>${esc(t.seats.join(", "))}</b></p>
  <img src="/api/ticket/${encodeURIComponent(t.id)}/qr" style="width:260px;max-width:90%;background:#fff;padding:12px;border-radius:16px">
  <p>Код: <b>${esc(t.id)}</b></p><p id="timer">Билет действует 10 минут</p>
  <script>const exp=${t.expiresAt};setInterval(()=>{const s=Math.max(0,Math.ceil((exp-Date.now())/1000));document.getElementById("timer").textContent=s?"Осталось: "+Math.floor(s/60)+":"+String(s%60).padStart(2,"0"):"Срок действия истёк";if(!s)setTimeout(()=>location.reload(),800)},1000)</script>
  </main></body></html>`);
});

app.get("/",(_,res)=>res.sendFile(path.join(__dirname,"streamly_cinema_redesign.html")));
app.listen(PORT,()=>console.log(`Streamly: http://localhost:${PORT}`));
