const fs=require("fs"),path=require("path"),{JSDOM}=require("jsdom");
const dom=new JSDOM("<!DOCTYPE html><body></body>",{url:"https://chatgpt.com/c/x",runScripts:"dangerously"});
const w=dom.window;
w.chrome={storage:{local:{get:()=>Promise.resolve({}),set:()=>Promise.resolve()},onChanged:{addListener(){}}},runtime:{getURL:p=>"file://"+p,sendMessage(){},lastError:null}};
if(!w.InputEvent)w.InputEvent=w.Event;
for(const f of["detector.js","masker.js","nlp-detector.js","content.js"])w.eval(fs.readFileSync(path.join(__dirname,"src",f),"utf8"));
const det=new w.GuardAI.Detector();
const variants=["Account Balance","Client Name, Account Balance, Phone Number","Account Holder\nJames Whitfield","Name: Account Balance","Column headers: Account Balance | Home Address | Medicare Number","Account Balance\n$12,450.00\nAccount Balance\n$8,200.00"];
const headerTokens=["Account Balance","Phone Number","Email Address","Home Address","Medicare Number","Client Name","Account Holder","Date Of Birth"];
let anyLeak=false;
for(const v of variants){const f=det.scan(v);const names=f.filter(x=>x.type==="NAME_PII").map(x=>x.value);const le=names.filter(n=>headerTokens.includes(n));if(le.length)anyLeak=true;console.log(JSON.stringify(v.slice(0,45)),"NAME_PII:",JSON.stringify(names),"hdr-as-name:",JSON.stringify(le));}
console.log("OVERALL:",anyLeak?"FAIL":"PASS — no header masked as a name in any variant");
process.exit(anyLeak?1:0);
