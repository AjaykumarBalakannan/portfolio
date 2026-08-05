// 3D cinematic intro — a climber hangs on a rope, waves hello, then yanks it so a
// stack of bricks on the top beam tumbles off with physics and converges into the page.
// Real-time WebGL via three.js (self-hosted, no CDN). ~one puppet, ~40 rigid bricks.

import * as THREE from '../libs/three.module.min.js';

const host   = document.getElementById('intro');
const canvas = document.getElementById('scene');
const hello  = document.querySelector('.hello');
const loading= document.querySelector('.loading');
const skipBtn= document.getElementById('skip');
const replay = document.getElementById('replay');
const RM = matchMedia('(prefers-reduced-motion:reduce)').matches;

// ---- palette (matches the site) ----
const BRICK_COLORS = [0xe0a12e,0x3a8975,0xbc5a34,0xece2cf,0x7d4a54,0xc8802f];
const COL = { ink:0x221c17, jacket:0x3b414d, pants:0xd8c9a2, shoe:0x24242e,
              skin:0xe7b489, hair:0x593a23, rope:0x9c6d3c, beam:0x4a3a2a };

let renderer, scene, camera;
let man, joints, rope, beam, bricks=[], ground;
let clock, raf=null, running=false, startT=0, phase='idle';
let shakeAmt=0, camBase=new THREE.Vector3();
const GRAV=-15, GROUND_Y=-3.2;
const LOOK=new THREE.Vector3(-0.7,3.9,0);
const SLOW=Math.max(1,+(new URLSearchParams(location.search).get('slow')||1)); // debug: ?slow=6

// timeline markers (seconds)
const TL = { hello:0.45, waveStart:0.7, waveEnd:1.7, pull:2.0, release:2.4,
             converge:3.95, reveal:4.55, fade:4.7, end:5.35 };
let domTimers=[];

function makeMat(color, opts={}){ const {r,m,...rest}=opts; return new THREE.MeshStandardMaterial({ color, roughness:r??0.72, metalness:m??0.02, ...rest }); }
function capsule(radius,len,mat){ const m=new THREE.Mesh(new THREE.CapsuleGeometry(radius,len,6,14),mat); m.castShadow=true; return m; }
function sphere(radius,mat){ const m=new THREE.Mesh(new THREE.SphereGeometry(radius,20,16),mat); m.castShadow=true; return m; }

// ---------- build the climber as a jointed puppet ----------
function buildMan(){
  const g = new THREE.Group();
  const matJ=makeMat(COL.jacket), matP=makeMat(COL.pants), matS=makeMat(COL.shoe,{r:.5}),
        matSk=makeMat(COL.skin,{r:.6}), matH=makeMat(COL.hair,{r:.8});

  // torso (leans slightly toward the rope)
  const torso = capsule(.42,.95,matJ); torso.position.y=1.15; torso.rotation.z=-.12; g.add(torso);
  // hips
  const hips = capsule(.4,.28,matP); hips.position.y=.5; g.add(hips);

  // head + hair
  const head = new THREE.Group(); head.position.set(.1,2.15,0);
  const skull=sphere(.42,matSk); head.add(skull);
  const hair=sphere(.45,matH); hair.scale.set(1,.8,1); hair.position.set(-.05,.16,-.02); head.add(hair);
  const fringe=sphere(.30,matH); fringe.scale.set(1,.5,.7); fringe.position.set(.12,.28,.28); head.add(fringe);
  const nose=sphere(.07,matSk); nose.position.set(.42,-.02,.05); head.add(nose);
  const eyeMat=makeMat(0x2a2118,{r:.4});
  const eye1=sphere(.05,eyeMat); eye1.position.set(.38,.05,.16); head.add(eye1);
  g.add(head);

  // helper to build an arm: shoulder group -> upper -> elbow group -> fore + hand
  function arm(side){ // side -1 left, +1 right
    const sh=new THREE.Group(); sh.position.set(side*.34,1.62,.05);
    const upper=capsule(.16,.6,matJ); upper.position.y=-.3; sh.add(upper);
    const el=new THREE.Group(); el.position.y=-.62; sh.add(el);
    const fore=capsule(.14,.55,matJ); fore.position.y=-.28; el.add(fore);
    const hand=sphere(.15,matSk); hand.position.y=-.58; el.add(hand);
    g.add(sh);
    return {sh,el,hand};
  }
  const armR=arm(1), armL=arm(-1);

  // helper to build a leg (bent, climbing pose)
  function leg(side){
    const hip=new THREE.Group(); hip.position.set(side*.2,.35,.05);
    const thigh=capsule(.19,.6,matP); thigh.position.y=-.32; hip.add(thigh);
    const knee=new THREE.Group(); knee.position.y=-.64; hip.add(knee);
    const shin=capsule(.16,.55,matP); shin.position.y=-.3; knee.add(shin);
    const shoe=new THREE.Mesh(new THREE.BoxGeometry(.26,.18,.5),matS); shoe.castShadow=true; shoe.position.set(0,-.62,.14); knee.add(shoe);
    g.add(hip);
    return {hip,knee};
  }
  const legR=leg(1), legL=leg(-1);
  // pose legs bent up (climbing)
  legR.hip.rotation.x=-.9; legR.knee.rotation.x=1.4;
  legL.hip.rotation.x=-.5; legL.knee.rotation.x=1.1;

  // arms up gripping the rope overhead (staggered like a climber)
  armR.sh.rotation.set(0,0,-2.55); armR.el.rotation.z=-.15;   // higher hand
  armL.sh.rotation.set(0,0, 2.35); armL.el.rotation.z=.35;    // lower hand

  joints={torso,head,armR,armL,legR,legL,eye1};
  return g;
}

// ---------- rope + top beam + brick stack ----------
function buildRig(){
  const ropeX=-2.15;
  // rope as a tube along a gently bent curve
  const curve=new THREE.CatmullRomCurve3([
    new THREE.Vector3(ropeX+.15,9.5,0), new THREE.Vector3(ropeX+.05,6,0),
    new THREE.Vector3(ropeX,3,.1), new THREE.Vector3(ropeX-.05,-1.5,0)
  ]);
  rope=new THREE.Mesh(new THREE.TubeGeometry(curve,40,.075,8,false),
        makeMat(COL.rope,{r:.85}));
  rope.castShadow=true; scene.add(rope);

  // top beam the rope hangs from + bricks rest on
  beam=new THREE.Group();
  const bar=new THREE.Mesh(new THREE.BoxGeometry(4.4,.5,1.1),makeMat(COL.beam,{r:.9}));
  bar.castShadow=true; bar.receiveShadow=true; beam.add(bar);
  beam.position.set(ropeX-.2,7.5,0); scene.add(beam);

  // brick wall stacked on the beam
  const cols=7, rows=4, S=.62, gap=S*1.02;
  const x0=beam.position.x-((cols-1)*gap)/2, y0=7.85+S/2, z0=0;
  let i=0;
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const s=S*(0.9+Math.random()*0.12);
    const mat=makeMat(BRICK_COLORS[i%BRICK_COLORS.length],{r:.6});
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(s,s,s),mat);
    mesh.castShadow=true; mesh.receiveShadow=true;
    // brick-lay offset every other row
    const offset=(r%2)?gap/2:0;
    mesh.position.set(x0+c*gap+offset-(r%2?gap/2:0), y0+r*gap, z0+(Math.random()-.5)*.2);
    mesh.userData={ v:new THREE.Vector3(), w:new THREE.Vector3(), mode:'rest',
                    half:s/2, tpos:new THREE.Vector3(), tquat:new THREE.Quaternion(), fade:1 };
    scene.add(mesh); bricks.push(mesh); i++;
  }
}

function buildScene(){
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.05;
  renderer.outputColorSpace=THREE.SRGBColorSpace;

  scene=new THREE.Scene();
  scene.background=new THREE.Color(COL.ink);
  scene.fog=new THREE.Fog(COL.ink,14,30);

  camera=new THREE.PerspectiveCamera(50,innerWidth/innerHeight,.1,100);
  camera.position.set(2.2,3.5,15.5); camBase.copy(camera.position);
  camera.lookAt(LOOK);

  // lighting — warm key + cool fill + soft ambient
  const hemi=new THREE.HemisphereLight(0xfff1d8,0x2a2018,.55); scene.add(hemi);
  const key=new THREE.DirectionalLight(0xffd9a0,2.1);
  key.position.set(6,12,8); key.castShadow=true;
  key.shadow.mapSize.set(2048,2048);
  key.shadow.camera.near=1; key.shadow.camera.far=40;
  key.shadow.camera.left=-12; key.shadow.camera.right=12;
  key.shadow.camera.top=14; key.shadow.camera.bottom=-8;
  key.shadow.bias=-0.0004; scene.add(key);
  const fill=new THREE.DirectionalLight(0x9fc4ff,.5); fill.position.set(-8,4,6); scene.add(fill);
  const rim=new THREE.DirectionalLight(0xffb066,.7); rim.position.set(-4,6,-8); scene.add(rim);

  // ground to catch shadows
  ground=new THREE.Mesh(new THREE.PlaneGeometry(60,60),
          new THREE.MeshStandardMaterial({color:0x1a140f,roughness:1}));
  ground.rotation.x=-Math.PI/2; ground.position.y=GROUND_Y; ground.receiveShadow=true; scene.add(ground);

  buildRig();
  man=buildMan(); man.position.set(-2.7,2.4,0); scene.add(man);
}

// ---------- animation helpers ----------
const easeInOut=t=>t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
function lerp(a,b,t){return a+(b-a)*t;}

function animateMan(t){
  const j=joints;
  // gentle hang bob + look-around
  man.position.y = 2.4 + Math.sin(t*1.8)*0.05;
  const looking = t<TL.pull;
  j.head.rotation.y = looking ? Math.sin(t*0.9)*0.55 : lerp(j.head.rotation.y,0,.1);
  j.head.rotation.z = looking ? Math.sin(t*1.3)*0.08 : 0;
  j.torso.rotation.y = looking ? Math.sin(t*0.7)*0.12 : 0;

  // WAVE with the left (outer) hand between waveStart..waveEnd
  if(t>TL.waveStart && t<TL.waveEnd){
    const w=(t-TL.waveStart)/(TL.waveEnd-TL.waveStart);
    const ease=Math.sin(Math.min(w,1)*Math.PI);           // rise then settle
    j.armL.sh.rotation.z = 2.35 + ease*0.9;               // lift arm out
    j.armL.el.rotation.z = 0.35 - ease*0.5 + Math.sin(t*12)*0.35*ease; // waggle forearm
    j.armL.sh.rotation.x = -ease*0.3;
  } else if(t>=TL.waveEnd && t<TL.pull){
    // return the hand to the rope
    const b=Math.min((t-TL.waveEnd)/0.3,1);
    j.armL.sh.rotation.z = lerp(2.35+0.9,2.35,b);
    j.armL.el.rotation.z = lerp(j.armL.el.rotation.z,0.35,b);
    j.armL.sh.rotation.x = lerp(j.armL.sh.rotation.x,0,b);
  }

  // PULL: both arms yank down, body climbs up a touch
  if(t>=TL.pull){
    const p=easeInOut(Math.min((t-TL.pull)/0.5,1));
    j.armR.sh.rotation.z = -2.55 + p*0.55;
    j.armL.sh.rotation.z =  2.35 - p*0.55;
    j.armR.el.rotation.z = -.15 - p*0.4;
    j.armL.el.rotation.z =  .35 + p*0.4;
    man.position.y += p*0.35;
    j.legR.hip.rotation.x = -0.9 - p*0.4;   // knees tuck on the pull
    j.legL.hip.rotation.x = -0.5 - p*0.4;
  }
}

function releaseBricks(){
  bricks.forEach(b=>{
    b.userData.mode='fall';
    // tip off the beam toward the camera + downward, with spin
    b.userData.v.set((Math.random()-.4)*2.2, 1+Math.random()*2, 2+Math.random()*3);
    b.userData.w.set((Math.random()-.5)*8,(Math.random()-.5)*8,(Math.random()-.5)*8);
  });
  // give the beam a little kick too
  beam.userData={kick:0.35};
}

function stepPhysics(dt){
  const q=new THREE.Quaternion();
  bricks.forEach(b=>{
    const u=b.userData;
    if(u.mode==='fall'){
      u.v.y += GRAV*dt;
      b.position.addScaledVector(u.v,dt);
      // integrate spin
      q.setFromEuler(new THREE.Euler(u.w.x*dt,u.w.y*dt,u.w.z*dt));
      b.quaternion.premultiply(q);
      // floor
      if(b.position.y < GROUND_Y+u.half){
        b.position.y=GROUND_Y+u.half;
        u.v.y*=-0.34; u.v.x*=0.62; u.v.z*=0.62; u.w.multiplyScalar(0.55);
        if(Math.abs(u.v.y)<1.2)u.v.y=0;
      }
    } else if(u.mode==='converge'){
      b.position.lerp(u.tpos,0.16);
      b.quaternion.slerp(u.tquat,0.16);
      if(b.position.distanceTo(u.tpos)<0.25){ u.fade-=dt*2.2; }
      if(u.fade<1){ b.material.transparent=true; b.material.opacity=Math.max(u.fade,0); if(u.fade<=0)b.visible=false; }
    }
  });
  if(beam.userData&&beam.userData.kick){ beam.rotation.z=Math.sin(performance.now()*0.02)*beam.userData.kick; beam.userData.kick*=0.92; }
}

// map each brick to a point over the hero mosaic so the pile "becomes" the page
function setConvergeTargets(){
  const tiles=[...document.querySelectorAll('.mosaic .tile')]
    .map(t=>t.getBoundingClientRect()).filter(r=>r.width>4);
  const v=new THREE.Vector3();
  bricks.forEach(b=>{
    const r = tiles.length? tiles[(Math.random()*tiles.length)|0] : {left:innerWidth*.3,top:innerHeight*.4,width:innerWidth*.4,height:200};
    const px=r.left+Math.random()*r.width, py=r.top+Math.random()*r.height;
    const ndcX=(px/innerWidth)*2-1, ndcY=-(py/innerHeight)*2+1;
    v.set(ndcX,ndcY,0.6).unproject(camera);           // a world point over that tile
    b.userData.tpos.copy(v);
    b.userData.tquat.identity();
    b.userData.mode='converge';
  });
}

// ---------- main loop ----------
function tick(){
  if(!running) return;
  const t=(performance.now()-startT)/1000/SLOW;
  const dt=Math.min(clock.getDelta(),0.05)/SLOW;

  animateMan(t);
  if(phase==='fall'||phase==='converge') stepPhysics(dt);
  rope.rotation.z=Math.sin(t*4)*0.006;

  // camera shake decays
  if(shakeAmt>0){
    camera.position.set(camBase.x+(Math.random()-.5)*shakeAmt,
                        camBase.y+(Math.random()-.5)*shakeAmt,
                        camBase.z+(Math.random()-.5)*shakeAmt*0.4);
    camera.lookAt(LOOK);
    shakeAmt*=0.9;
  }

  renderer.render(scene,camera);
  raf=requestAnimationFrame(tick);
}

function schedule(){
  domTimers.forEach(clearTimeout); domTimers=[];
  const at=(s,fn)=>domTimers.push(setTimeout(fn,s*1000*SLOW));
  at(TL.hello,   ()=>{ if(loading)loading.style.display='none'; hello.classList.add('show'); });
  at(TL.pull,    ()=>{ hello.classList.add('hide'); });
  at(TL.release, ()=>{ phase='fall'; shakeAmt=0.5; releaseBricks(); });
  at(TL.converge,()=>{ phase='converge'; setConvergeTargets(); });
  at(TL.reveal,  ()=>{ document.body.classList.add('reveal'); });
  at(TL.fade,    ()=>{ host.classList.add('done'); });
  at(TL.end,     ()=>{ finish(); });
}

function finish(){
  running=false; if(raf)cancelAnimationFrame(raf);
  host.style.display='none'; replay.hidden=false;
  // free GPU memory
  renderer.dispose();
}

function start(){
  document.body.classList.add('cinema'); document.body.classList.remove('reveal');
  host.style.display='block'; host.classList.remove('done');
  hello.classList.remove('show','hide'); replay.hidden=true;
  if(loading) loading.style.display='';

  // fresh scene each run (simple + reliable for replay)
  bricks=[];
  if(renderer){ renderer.dispose(); }
  buildScene();
  clock=new THREE.Clock(); startT=performance.now(); phase='intro'; running=true; shakeAmt=0;
  schedule();
  raf=requestAnimationFrame(tick);
}

function skip(){
  domTimers.forEach(clearTimeout); domTimers=[];
  running=false; if(raf)cancelAnimationFrame(raf);
  document.body.classList.add('cinema','reveal');
  host.classList.add('done');
  setTimeout(()=>{ host.style.display='none'; replay.hidden=false; if(renderer)renderer.dispose(); },500);
}

addEventListener('resize',()=>{
  if(!renderer)return;
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
});
skipBtn.addEventListener('click',skip);
replay.addEventListener('click',start);

if(RM){ host.style.display='none'; document.body.classList.add('cinema','reveal'); replay.hidden=false; }
else { start(); }
