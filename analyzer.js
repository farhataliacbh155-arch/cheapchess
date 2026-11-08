/* ===== analysis engine: deeper search + stronger evaluation (used by Game review, Hint and Coach) ===== */
const AVAL={p:100,n:320,b:330,r:500,q:900,k:0};
const AMATE=100000;
const PST={
p:[0,0,0,0,0,0,0,0,50,50,50,50,50,50,50,50,10,10,20,30,30,20,10,10,5,5,10,25,25,10,5,5,0,0,0,20,20,0,0,0,5,-5,-10,0,0,-10,-5,5,5,10,10,-20,-20,10,10,5,0,0,0,0,0,0,0,0],
n:[-50,-40,-30,-30,-30,-30,-40,-50,-40,-20,0,0,0,0,-20,-40,-30,0,10,15,15,10,0,-30,-30,5,15,20,20,15,5,-30,-30,0,15,20,20,15,0,-30,-30,5,10,15,15,10,5,-30,-40,-20,0,5,5,0,-20,-40,-50,-40,-30,-30,-30,-30,-40,-50],
b:[-20,-10,-10,-10,-10,-10,-10,-20,-10,0,0,0,0,0,0,-10,-10,0,5,10,10,5,0,-10,-10,5,5,10,10,5,5,-10,-10,0,10,10,10,10,0,-10,-10,10,10,10,10,10,10,-10,-10,5,0,0,0,0,5,-10,-20,-10,-10,-10,-10,-10,-10,-20],
r:[0,0,0,0,0,0,0,0,5,10,10,10,10,10,10,5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,0,0,0,5,5,0,0,0],
q:[-20,-10,-10,-5,-5,-10,-10,-20,-10,0,0,0,0,0,0,-10,-10,0,5,5,5,5,0,-10,-5,0,5,5,5,5,0,-5,0,0,5,5,5,5,0,-5,-10,5,5,5,5,5,0,-10,-10,0,5,0,0,0,0,-10,-20,-10,-10,-5,-5,-10,-10,-20],
k:[-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-20,-30,-30,-40,-40,-30,-30,-20,-10,-20,-20,-20,-20,-20,-20,-10,20,20,0,0,0,0,20,20,20,30,10,0,0,10,30,20],
e:[-50,-40,-30,-20,-20,-30,-40,-50,-30,-20,-10,0,0,-10,-20,-30,-30,-10,20,30,30,20,-10,-30,-30,-10,30,40,40,30,-10,-30,-30,-10,30,40,40,30,-10,-30,-30,-10,20,30,30,20,-10,-30,-30,-30,0,0,0,0,-30,-30,-50,-30,-30,-30,-30,-30,-30,-50]
};
const PASSB=[0,5,10,20,35,60,100,0];
const AN_N8=[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]],AN_KD=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
function anAtt(b,sq,byW){
  const r=sq>>3,f=sq&7,pr=byW?r+1:r-1,pp=byW?"P":"p";
  if(pr>=0&&pr<8){if(f>0&&b[pr*8+f-1]===pp)return true;if(f<7&&b[pr*8+f+1]===pp)return true}
  const kn=byW?"N":"n";
  for(let i=0;i<8;i++){const rr=r+AN_N8[i][0],ff=f+AN_N8[i][1];if(rr>=0&&rr<8&&ff>=0&&ff<8&&b[rr*8+ff]===kn)return true}
  const kg=byW?"K":"k";
  for(let i=0;i<8;i++){const rr=r+AN_KD[i][0],ff=f+AN_KD[i][1];if(rr>=0&&rr<8&&ff>=0&&ff<8&&b[rr*8+ff]===kg)return true}
  const R=byW?"R":"r",Q=byW?"Q":"q",B=byW?"B":"b";
  for(let k=0;k<8;k++){
    const dr=AN_KD[k][0],df=AN_KD[k][1],dg=dr!==0&&df!==0;let rr=r+dr,ff=f+df;
    while(rr>=0&&rr<8&&ff>=0&&ff<8){const p=b[rr*8+ff];if(p){if(p===Q||p===(dg?B:R))return true;break}rr+=dr;ff+=df}
  }
  return false;
}
const anIn=(s,col)=>{const W=col==="w";return anAtt(s.b,s.b.indexOf(W?"K":"k"),!W)};
// fast move generator for the analyzer (same moves as gen(), without the closures); caps = captures and promotions only
function anGen(s,caps){
  const b=s.b,out=[],W=s.t==="w";
  for(let i=0;i<64;i++){
    const p=b[i];if(!p||(p<"a")!==W)continue;
    const r=i>>3,f=i&7,t=p.toLowerCase();
    if(t==="p"){
      const d=W?-1:1,nr=r+d;if(nr<0||nr>7)continue;
      const last=nr===0||nr===7;
      for(let df=-1;df<=1;df+=2){
        const nf=f+df;if(nf<0||nf>7)continue;
        const to=nr*8+nf,q=b[to];
        if(q&&(q<"a")!==W){if(last){out.push({from:i,to,promo:"q"},{from:i,to,promo:"r"},{from:i,to,promo:"b"},{from:i,to,promo:"n"})}else out.push({from:i,to})}
        else if(to===s.ep)out.push({from:i,to,ep:1});
      }
      const to=nr*8+f;
      if(!b[to]){
        if(last){out.push({from:i,to,promo:"q"},{from:i,to,promo:"r"},{from:i,to,promo:"b"},{from:i,to,promo:"n"})}
        else if(!caps){out.push({from:i,to});if(r===(W?6:1)&&!b[to+d*8])out.push({from:i,to:to+d*8,dbl:1})}
      }
    }else if(t==="n"||t==="k"){
      const T=t==="n"?AN_N8:AN_KD;
      for(let k=0;k<8;k++){
        const nr=r+T[k][0],nf=f+T[k][1];if(nr<0||nr>7||nf<0||nf>7)continue;
        const to=nr*8+nf,q=b[to];
        if(q?(q<"a")!==W:!caps)out.push({from:i,to});
      }
    }else{
      const lo=t==="b"?4:0,hi=t==="r"?4:8;
      for(let k=lo;k<hi;k++){
        const dr=ANQ[k][0],df=ANQ[k][1];let nr=r+dr,nf=f+df;
        while(nr>=0&&nr<8&&nf>=0&&nf<8){
          const to=nr*8+nf,q=b[to];
          if(q){if((q<"a")!==W)out.push({from:i,to});break}
          if(!caps)out.push({from:i,to});
          nr+=dr;nf+=df;
        }
      }
    }
  }
  if(!caps){
    const hr=W?56:0,ki=hr+4;
    if(b[ki]===(W?"K":"k")&&!anAtt(b,ki,!W)){
      if(s.c.includes(W?"K":"k")&&!b[hr+5]&&!b[hr+6]&&b[hr+7]===(W?"R":"r")&&!anAtt(b,hr+5,!W))out.push({from:ki,to:hr+6,castle:1});
      if(s.c.includes(W?"Q":"q")&&!b[hr+1]&&!b[hr+2]&&!b[hr+3]&&b[hr]===(W?"R":"r")&&!anAtt(b,hr+3,!W))out.push({from:ki,to:hr+2,castle:1});
    }
  }
  return out;
}
const ANQ=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
function anLegal(s,caps){const out=[],ms=anGen(s,caps);for(let i=0;i<ms.length;i++){if(!anIn(apply(s,ms[i]),s.t))out.push(ms[i])}return out}
const ZI={P:0,N:1,B:2,R:3,Q:4,K:5,p:6,n:7,b:8,r:9,q:10,k:11};
const ZB=(()=>{let x=0x9e3779b9|0;const r=()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return x>>>0};const a=[];for(let i=0;i<12*64+32;i++)a.push([r(),r()]);return a})();
function anHash(s){
  let h1=0,h2=0;const b=s.b;
  for(let i=0;i<64;i++){const p=b[i];if(p){const z=ZB[ZI[p]*64+i];h1^=z[0];h2^=z[1]}}
  if(s.t==="b"){h1^=0x5bd1e995;h2^=0x1b873593}
  for(let i=0;i<s.c.length;i++){const z=ZB[768+"KQkq".indexOf(s.c[i])];h1^=z[0];h2^=z[1]}
  if(s.ep>=0){const z=ZB[776+(s.ep&7)];h1^=z[0];h2^=z[1]}
  return (h1>>>0)*1048576+(h2>>>12);
}
// static evaluation in centipawns, from White's point of view
function anEval(s){
  const b=s.b,pf=[new Array(8).fill(0),new Array(8).fill(0)],wmin=new Array(8).fill(9),bmax=new Array(8).fill(-1),wr=[],br=[],wp_=[],bp_=[];
  let mat=0,np=0,wb=0,bb=0,wk=-1,bk=-1;
  for(let i=0;i<64;i++){
    const p=b[i];if(!p)continue;
    const t=p.toLowerCase(),W=p<"a",r=i>>3,f=i&7;
    if(t==="k"){if(W)wk=i;else bk=i;continue}
    const v=AVAL[t],idx=W?i:i^56,pv=PST[t][idx];
    mat+=W?v+pv:-(v+pv);
    if(t==="p"){if(W){pf[0][f]++;wp_.push(i);if(r<wmin[f])wmin[f]=r}else{pf[1][f]++;bp_.push(i);if(r>bmax[f])bmax[f]=r}}
    else{np+=v;if(t==="b"){if(W)wb++;else bb++}else if(t==="r"){if(W)wr.push(i);else br.push(i)}}
  }
  const ph=Math.min(1,np/6400),eg=1-ph;
  let sc=mat;
  const kv=(sq,W)=>{const i=W?sq:sq^56;return PST.k[i]*ph+PST.e[i]*eg};
  if(wk>=0)sc+=kv(wk,true);if(bk>=0)sc-=kv(bk,false);
  if(wb>=2)sc+=30;if(bb>=2)sc-=30;
  // pawn structure
  for(const i of wp_){
    const r=i>>3,f=i&7;
    if(pf[0][f]>1)sc-=8;
    if((f===0||pf[0][f-1]===0)&&(f===7||pf[0][f+1]===0))sc-=12;
    // a white pawn is passed when no black pawn stands ahead of it (smaller row) on its file or the neighbours
    let pass=true;
    for(const j of bp_){const jr=j>>3,jf=j&7;if(Math.abs(jf-f)<=1&&jr<r){pass=false;break}}
    if(pass)sc+=Math.round(PASSB[7-r]*(1+eg));
  }
  for(const i of bp_){
    const r=i>>3,f=i&7;
    if(pf[1][f]>1)sc+=8;
    if((f===0||pf[1][f-1]===0)&&(f===7||pf[1][f+1]===0))sc+=12;
    let pass=true;
    for(const j of wp_){const jr=j>>3,jf=j&7;if(Math.abs(jf-f)<=1&&jr>r){pass=false;break}}
    if(pass)sc-=Math.round(PASSB[r]*(1+eg));
  }
  for(const i of wr){const f=i&7;if(pf[0][f]===0)sc+=pf[1][f]===0?20:10}
  for(const i of br){const f=i&7;if(pf[1][f]===0)sc-=pf[0][f]===0?20:10}
  // king safety: pawn shield in the middlegame
  if(ph>0.35){
    if(wk>=0&&(wk>>3)>=6){let n=0;const f=wk&7;for(let g=Math.max(0,f-1);g<=Math.min(7,f+1);g++){if(b[(wk>>3)*8-8+g-f]==="P")n+=2;else if(b[(wk>>3)*8-16+g-f]==="P")n+=1}sc+=Math.round((n-4)*5*ph)}
    if(bk>=0&&(bk>>3)<=1){let n=0;const f=bk&7;for(let g=Math.max(0,f-1);g<=Math.min(7,f+1);g++){if(b[(bk>>3)*8+8+g-f]==="p")n+=2;else if(b[(bk>>3)*8+16+g-f]==="p")n+=1}sc-=Math.round((n-4)*5*ph)}
  }
  return sc+(s.t==="w"?10:-10);
}
const anEvalSide=s=>s.t==="w"?anEval(s):-anEval(s);
const AN={tt:new Map(),nodes:0,deadline:0,stopped:false,killers:[],hist:new Int32Array(4096),path:[],rootHist:null};
function anOrder(s,ls,ply,ttm){
  const b=s.b,K=AN.killers[ply];
  for(const m of ls){
    let sc;
    if(ttm&&m.from===ttm[0]&&m.to===ttm[1]&&(m.promo||"")===ttm[2])sc=1e7;
    else{
      const cap=b[m.to]||(m.ep?"p":"");
      if(cap)sc=1e6+AVAL[cap.toLowerCase()]*10-AVAL[b[m.from].toLowerCase()]/100;
      else if(m.promo)sc=9e5;
      else{const kk=m.from*64+m.to;sc=K&&(K[0]===kk||K[1]===kk)?8e5:AN.hist[kk]}
    }
    m.o=sc;
  }
  ls.sort((x,y)=>y.o-x.o);
}
function anQ(s,al,be,ply,qd){
  AN.nodes++;if((AN.nodes&1023)===0&&Date.now()>AN.deadline)AN.stopped=true;if(AN.stopped)return 0;
  const inChk=anIn(s,s.t);let best=-AMATE,stand=-AMATE;
  if(!inChk){stand=anEvalSide(s);if(stand>=be)return stand;if(stand>al)al=stand;best=stand;if(qd>=8)return stand}
  const ls=anGen(s,!inChk);
  anOrder(s,ls,ply,null);let legal=0;
  for(let i=0;i<ls.length;i++){
    const m=ls[i];
    if(!inChk&&!m.promo){const cv=m.ep?100:AVAL[s.b[m.to].toLowerCase()];if(stand+cv+200<al)continue}
    const ns=apply(s,m);if(anIn(ns,s.t))continue;
    legal++;
    const v=-anQ(ns,-be,-al,ply+1,qd+1);
    if(AN.stopped)return 0;
    if(v>best){best=v;if(v>al){al=v;if(al>=be)break}}
  }
  if(inChk&&!legal)return -AMATE+ply;
  return best;
}
function anNeg(s,d,al,be,ply,nullOk){
  AN.nodes++;if((AN.nodes&1023)===0&&Date.now()>AN.deadline)AN.stopped=true;if(AN.stopped)return 0;
  const h=anHash(s);
  if(ply>0){
    if(s.hm>=100)return 0;
    for(let i=ply-2;i>=0&&i>=ply-s.hm;i-=2)if(AN.path[i]===h)return 0;
    if(AN.rootHist&&AN.rootHist.has(h))return 0;
  }
  AN.path[ply]=h;
  const inChk=anIn(s,s.t);
  if(inChk&&ply<40)d++;
  if(d<=0)return anQ(s,al,be,ply,0);
  const alo=al;let ttm=null;const e=AN.tt.get(h);
  if(e){
    ttm=e.m;
    if(e.d>=d&&ply>0){
      let sc=e.s;if(sc>AMATE-1000)sc-=ply;else if(sc<-AMATE+1000)sc+=ply;
      if(e.f===0||(e.f===1&&sc>=be)||(e.f===2&&sc<=al))return sc;
    }
  }
  if(nullOk&&!inChk&&d>=3&&ply>0){
    let np=0;for(let i=0;i<64;i++){const p=s.b[i];if(p&&(p<"a")===(s.t==="w")){const t=p.toLowerCase();if(t!=="p"&&t!=="k")np++}}
    if(np>=2&&anEvalSide(s)>=be){
      const ns={b:s.b,t:s.t==="w"?"b":"w",c:s.c,ep:-1,hm:s.hm+1};
      const v=-anNeg(ns,d-3,-be,-be+1,ply+1,false);
      if(AN.stopped)return 0;
      if(v>=be)return v>=AMATE-1000?be:v;
    }
  }
  const ls=anGen(s,false);
  anOrder(s,ls,ply,ttm);
  let best=-AMATE-1,bm=null,moves=0;
  for(const m of ls){
    const ns=apply(s,m);if(anIn(ns,s.t))continue;
    const quiet=!(s.b[m.to]||m.ep||m.promo);let v;
    if(moves===0)v=-anNeg(ns,d-1,-be,-al,ply+1,true);
    else{
      let r=0;if(d>=3&&moves>=4&&quiet&&!inChk)r=moves>=8?2:1;
      v=-anNeg(ns,d-1-r,-al-1,-al,ply+1,true);
      if(v>al&&(r>0||v<be))v=-anNeg(ns,d-1,-be,-al,ply+1,true);
    }
    if(AN.stopped)return 0;
    moves++;
    if(v>best){best=v;bm=m;if(v>al){al=v;if(al>=be){
      if(quiet){const kk=m.from*64+m.to,K=AN.killers[ply]||(AN.killers[ply]=[0,0]);if(K[0]!==kk){K[1]=K[0];K[0]=kk}AN.hist[kk]+=d*d}
      break}}}
  }
  if(!moves)return inChk?-AMATE+ply:0;
  let sc=best;if(sc>AMATE-1000)sc+=ply;else if(sc<-AMATE+1000)sc-=ply;
  if(AN.tt.size>400000)AN.tt.clear();
  AN.tt.set(h,{d,s:sc,f:best<=alo?2:best>=be?1:0,m:bm?[bm.from,bm.to,bm.promo||""]:null});
  return best;
}
// anSearch(state,{ms,minDepth,maxDepth,hist:[hashes of earlier positions],exclude:[moves]})
// returns {score (for the side to move), move, depth, pv:[moves], nodes}
function anSearch(s,o){
  o=o||{};const ms=o.ms||400,minD=o.minDepth||3,maxD=o.maxDepth||14,t0=Date.now();
  const all=anLegal(s);
  if(!all.length)return{score:anIn(s,s.t)?-AMATE:0,move:null,depth:0,pv:[],nodes:0,over:true};
  let ls=all;
  if(o.exclude&&o.exclude.length)ls=all.filter(m=>!o.exclude.some(x=>x.from===m.from&&x.to===m.to&&(x.promo||"")===(m.promo||"")));
  if(!ls.length)return{score:null,move:null,depth:0,pv:[],nodes:0};
  AN.nodes=0;AN.stopped=false;AN.killers=[];AN.hist=new Int32Array(4096);AN.path=[];
  AN.rootHist=o.hist?new Set(o.hist):null;AN.deadline=t0+ms*2.5;
  const rootHash=anHash(s);anOrder(s,ls,0,null);
  let best=ls[0],bs=0,depth=0;
  if(ls.length===1&&!o.exclude){return{score:anEvalSide(s),move:ls[0],depth:1,pv:[ls[0]],nodes:0,forced:true}}
  for(let d=1;d<=maxD;d++){
    let al=-AMATE-1,be=AMATE+1,cur=null,cs=-AMATE-1;
    if(depth>0)ls.sort((x,y)=>(y===best)-(x===best)||y.o-x.o);
    for(let i=0;i<ls.length;i++){
      const m=ls[i],ns=apply(s,m);AN.path[0]=rootHash;let v;
      if(i===0)v=-anNeg(ns,d-1,-be,-al,1,true);
      else{v=-anNeg(ns,d-1,-al-1,-al,1,true);if(!AN.stopped&&v>al&&v<be)v=-anNeg(ns,d-1,-be,-al,1,true)}
      if(AN.stopped)break;
      m.o=v;
      if(v>cs){cs=v;cur=m;if(v>al)al=v}
    }
    if(AN.stopped)break;
    best=cur;bs=cs;depth=d;
    if(Math.abs(bs)>AMATE-200&&d>=minD)break;
    if(d>=minD&&Date.now()-t0>ms*0.45)break;
  }
  // principal variation from the transposition table
  const pv=[best];let cs2=apply(s,best);
  for(let i=0;i<8;i++){
    const e=AN.tt.get(anHash(cs2));if(!e||!e.m)break;
    const m=anLegal(cs2).find(x=>x.from===e.m[0]&&x.to===e.m[1]&&(x.promo||"")===e.m[2]);if(!m)break;
    pv.push(m);cs2=apply(cs2,m);
  }
  return{score:bs,move:best,depth,pv,nodes:AN.nodes};
}
