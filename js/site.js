// role words cycling in the ochre tile
(function(){
  const words=['Data Scientist','ML Engineer','NLP + LLM systems','Analytics Engineer'];
  const el=document.getElementById('typed'); if(!el)return;
  let w=0,c=0,del=false;
  function tick(){
    const word=words[w];
    el.textContent=del?word.slice(0,c--):word.slice(0,c++);
    if(!del&&c===word.length+1){del=true;c=word.length;return setTimeout(tick,1500);}
    if(del&&c<0){del=false;c=0;w=(w+1)%words.length;return setTimeout(tick,260);}
    setTimeout(tick,del?40:70);
  }
  setTimeout(tick,4800);
})();

// scroll reveal for the sections below the hero
(function(){
  const io=new IntersectionObserver((es)=>{es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.12});
  document.querySelectorAll('.rv').forEach(el=>io.observe(el));
})();

// tiny warm k-means that keeps settling in one hero tile
(function(){
  const cv=document.getElementById('clust'); if(!cv)return;
  const ctx=cv.getContext('2d');
  const COL=['#e0a12e','#3a8975','#bc5a34'];
  let W,H,pts=[],cen=[],asg=[],step=0,timer=null;
  function size(){const r=cv.getBoundingClientRect();W=cv.width=Math.max(160,r.width);H=cv.height=Math.max(120,r.height);}
  function seed(){pts=[];[[.28,.32],[.72,.34],[.5,.74]].forEach(([cx,cy])=>{for(let i=0;i<18;i++)pts.push({x:cx*W+(Math.random()-.5)*W*.3,y:cy*H+(Math.random()-.5)*H*.3});});cen=Array.from({length:3},()=>({x:Math.random()*W,y:Math.random()*H}));asg=pts.map(()=>0);step=0;}
  function assign(){let m=false;pts.forEach((p,i)=>{let b=0,bd=1e9;cen.forEach((c,k)=>{const d=(p.x-c.x)**2+(p.y-c.y)**2;if(d<bd){bd=d;b=k;}});if(asg[i]!==b){asg[i]=b;m=true;}});return m;}
  function move(){cen=cen.map((_,k)=>{const g=pts.filter((_,i)=>asg[i]===k);if(!g.length)return{x:Math.random()*W,y:Math.random()*H};return{x:g.reduce((s,p)=>s+p.x,0)/g.length,y:g.reduce((s,p)=>s+p.y,0)/g.length};});}
  function draw(){ctx.clearRect(0,0,W,H);pts.forEach((p,i)=>{ctx.beginPath();ctx.arc(p.x,p.y,3,0,7);ctx.fillStyle=COL[asg[i]];ctx.globalAlpha=.8;ctx.fill();});ctx.globalAlpha=1;cen.forEach((c,k)=>{ctx.beginPath();ctx.arc(c.x,c.y,7,0,7);ctx.strokeStyle=COL[k];ctx.lineWidth=2;ctx.stroke();});}
  function loop(){const m=assign();move();step++;draw();if(m&&step<30){timer=setTimeout(loop,420);}else{timer=setTimeout(()=>{seed();loop();},2200);}}
  const mq=matchMedia('(prefers-reduced-motion:reduce)');
  size();seed();draw();
  if(!mq.matches)timer=setTimeout(loop,5200);
  addEventListener('resize',()=>{clearTimeout(timer);size();seed();draw();if(!mq.matches)timer=setTimeout(loop,600);});
})();
