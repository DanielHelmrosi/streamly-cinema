require("dotenv").config();
const express=require("express");
const nodemailer=require("nodemailer");
const QRCode=require("qrcode");
const path=require("path");

const app=express();
const PORT=Number(process.env.PORT||3000);
const tickets=new Map();

app.use(express.json({limit:"1mb"}));
app.use(express.static(__dirname));

const transporter=nodemailer.createTransport({
  host:String(process.env.SMTP_HOST||"smtp.gmail.com").trim(),
  port:Number(process.env.SMTP_PORT||587),
  secure:String(process.env.SMTP_SECURE||"false").trim().toLowerCase()==="true",
  auth:{
    user:String(process.env.SMTP_USER||"").trim(),
    pass:String(process.env.SMTP_PASS||"").replace(/\s+/g,"")
  },
  connectionTimeout:12000,
  greetingTimeout:12000,
  socketTimeout:15000
});

function baseUrl(req){
 const v=String(process.env.PUBLIC_BASE_URL||"").trim().replace(/\/+$/,"");
 return v||`${req.protocol}://${req.get("host")}`;
}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

app.get("/api/health",(_,res)=>res.json({
 ok:true,smtpConfigured:Boolean(process.env.SMTP_USER&&process.env.SMTP_PASS)
}));

app.post("/api/send-ticket",async(req,res)=>{
 try{
  const {email,id,movie,cinema,date,time,seats}=req.body||{};
  if(!email||!id||!movie||!cinema||!date||!time||!Array.isArray(seats)||!seats.length)
   return res.status(400).json({error:"Не заполнены данные билета"});
  if(!process.env.SMTP_USER||!process.env.SMTP_PASS)
   return res.status(500).json({error:"SMTP_USER или SMTP_PASS не настроены в Render"});

  const ticket={email,id,movie,cinema,date,time,seats,createdAt:Date.now()};
  tickets.set(id,ticket);
  const base=baseUrl(req);
  const ticketUrl=`${base}/ticket/${encodeURIComponent(id)}`;
  const qrUrl=`${base}/api/ticket/${encodeURIComponent(id)}/qr`;
  const qr=await QRCode.toBuffer(ticketUrl,{type:"png",width:420,margin:2});

  await transporter.sendMail({
   from:process.env.MAIL_FROM||`Streamly <${process.env.SMTP_USER}>`,
   to:email,
   subject:`Streamly — QR-билет: ${movie}`,
   text:`Streamly Pass\n${movie}\n${cinema}\n${date} ${time}\nМеста: ${seats.join(", ")}\nКод: ${id}\n${ticketUrl}`,
   html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;background:#111;color:#fff;border-radius:18px">
    <div style="letter-spacing:.15em;color:#aaa">STREAMLY PASS</div><h1>${esc(movie)}</h1>
    <p>${esc(cinema)}<br>${esc(date)} · ${esc(time)}<br>Места: <b>${esc(seats.join(", "))}</b></p>
    <div style="display:inline-block;background:#fff;padding:12px;border-radius:16px"><img src="cid:qr" width="260" height="260"></div>
    <p>Код: <b>${esc(id)}</b></p><p><a href="${ticketUrl}" style="background:#fff;color:#000;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Открыть билет</a></p>
   </div>`,
   attachments:[{filename:"streamly-ticket-qr.png",content:qr,cid:"qr"}]
  });
  res.json({ok:true,ticketUrl,qrUrl});
 }catch(err){
  console.error("SEND MAIL ERROR:",err.code,err.message);
  const msg=err.code==="EAUTH"?"Gmail отклонил вход. Проверьте SMTP_USER и пароль приложения Google."
   :(err.code==="ETIMEDOUT"||err.code==="ESOCKET")?"Не удалось подключиться к SMTP Gmail."
   :"Не удалось отправить письмо. Проверьте SMTP в Render.";
  res.status(500).json({error:msg});
 }
});

app.get("/api/ticket/:id/qr",async(req,res)=>{
 const t=tickets.get(req.params.id);
 if(!t)return res.status(404).send("Билет не найден");
 try{
  const png=await QRCode.toBuffer(`${baseUrl(req)}/ticket/${encodeURIComponent(t.id)}`,{type:"png",width:420,margin:2});
  res.type("png").send(png);
 }catch(e){res.status(500).send("QR error")}
});

app.get("/ticket/:id",(req,res)=>{
 const t=tickets.get(req.params.id);
 if(!t)return res.status(404).send("<h1>Билет не найден</h1>");
 res.send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Streamly Pass</title>
 <body style="margin:0;background:#090909;color:#fff;font-family:Arial;display:grid;min-height:100vh;place-items:center"><main style="width:min(520px,90%);background:#171717;border:1px solid #333;border-radius:22px;padding:28px;text-align:center">
 <div style="letter-spacing:.18em;color:#aaa;font-size:12px">STREAMLY PASS</div><h1>${esc(t.movie)}</h1>
 <p>${esc(t.cinema)}<br>${esc(t.date)} · ${esc(t.time)}<br>Места: <b>${esc(t.seats.join(", "))}</b></p>
 <img src="/api/ticket/${encodeURIComponent(t.id)}/qr" style="width:260px;max-width:90%;background:#fff;padding:12px;border-radius:16px"><p>Код: <b>${esc(t.id)}</b></p>
 </main></body></html>`);
});

app.get("/",(_,res)=>res.sendFile(path.join(__dirname,"streamly_cinema_redesign.html")));
app.listen(PORT,()=>console.log(`Streamly: http://localhost:${PORT}`));
