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

// scroll reveal for the sections below the hero.
// Cards inside a group are numbered so they emerge one after another instead of
// the whole grid landing in one hit — the delay itself lives in CSS (--i).
(function(){
  // Accent is stamped here rather than via CSS :nth-of-type, which counts every
  // sibling div (the eyebrow and heading included) and so shifts the whole colour
  // run the moment anything is added above the cards.
  const PALETTE=['--a1','--a2','--a3','--a4'];
  ['.job','.stackcard','.proj','.edu','.cert'].forEach(sel=>{
    document.querySelectorAll(sel).forEach((el,i)=>{
      el.style.setProperty('--i',i);
      if(!el.style.getPropertyValue('--accent'))
        el.style.setProperty('--accent',`var(${PALETTE[i%PALETTE.length]})`);
    });
  });
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

// Floating pill nav: appears once the reader is past the opening spread, and
// highlights whichever section is currently under the middle of the viewport.
// Hidden at the top on purpose — the contents index is the navigation up there,
// and two navs competing would be noise.
(function () {
  const pill = document.getElementById('pillnav');
  if (!pill) return;
  const links = [...pill.querySelectorAll('a')];
  const targets = links
    .map((a) => ({ a, el: document.querySelector(a.getAttribute('href')) }))
    .filter((t) => t.el);

  function update() {
    const hero = document.getElementById('hero');
    const past = hero ? window.scrollY > hero.offsetHeight * 0.6 : window.scrollY > 400;
    pill.classList.toggle('show', past);

    // Nearest section to the viewport's middle, rather than the first one
    // intersecting — that reads as "where am I" instead of "what just entered".
    const mid = window.scrollY + window.innerHeight / 2;
    let best = null, bestGap = Infinity;
    for (const t of targets) {
      const gap = Math.abs(t.el.offsetTop + t.el.offsetHeight / 2 - mid);
      if (gap < bestGap) { bestGap = gap; best = t; }
    }
    for (const t of targets) t.a.classList.toggle('on', t === best);
  }

  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { update(); ticking = false; });
  }, { passive: true });
  update();
})();

// Drives the tear. The paper is masked with a centre band that widens as the
// opening spread leaves the viewport, so the dark section behind shows through
// a gap that grows into a split page.
//
// Scroll position rather than a CSS scroll-timeline: animation-timeline is
// still Chromium-only, and this needs to behave the same in Safari, which is
// where a good share of recruiters will open the site.
(function () {
  const hero = document.getElementById('hero');
  if (!hero || !hero.classList.contains('paper')) return;
  if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;

  let ticking = false;
  function update() {
    const rect = hero.getBoundingClientRect();
    // Starts once the spread's bottom edge reaches the lower third of the
    // viewport, completes as it clears the top. Nothing happens on the way in.
    const start = window.innerHeight * 0.66;
    const progress = (start - rect.bottom) / start;
    const t = Math.max(0, Math.min(1, progress));
    // Eased so the first movement is gentle and the split accelerates.
    hero.style.setProperty('--tear', (t * t).toFixed(4));
  }

  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { update(); ticking = false; });
  }, { passive: true });
  addEventListener('resize', update, { passive: true });
  update();
})();
