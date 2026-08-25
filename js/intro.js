// Interactive particle gate. Thousands of GPU points assemble into drifting
// clusters (a nod to embeddings / k-means), orbit with real depth, react to the
// cursor, then burst apart to reveal the page. Real-time WebGL via three.js.

import * as THREE from '../libs/three.module.min.js';

const gate   = document.getElementById('gate');
const canvas = document.getElementById('scene');
const copy   = document.getElementById('gateCopy');
const hint   = document.getElementById('hint');
const enterB = document.getElementById('enter');
const skipB  = document.getElementById('skip');
const replay = document.getElementById('replay');
const RM = matchMedia('(prefers-reduced-motion:reduce)').matches;

// warm palette -> point colors (kept a touch dim; additive blending brightens them)
const PAL = [[0.78,0.55,0.16],[0.20,0.50,0.42],[0.70,0.33,0.19],[0.80,0.74,0.60],[0.46,0.28,0.33],[0.72,0.47,0.20]];

let renderer, scene, camera, points, mat, group, clock;
let raf=null, running=false, startT=0, leaving=false, timers=[];
let mouse={x:0,y:0}, rotTarget={x:0,y:0}, rot={x:0,y:0}, pulse=0;

const N = innerWidth<640 ? 8000 : 16000;
const CLUSTERS = 7;

function gauss(s){ // small gaussian via central-limit
  return ((Math.random()+Math.random()+Math.random())/3-0.5)*2*s;
}

function buildPoints(){
  const g = new THREE.BufferGeometry();
  const target  = new Float32Array(N*3);
  const scatter = new Float32Array(N*3);
  const color   = new Float32Array(N*3);
  const rand    = new Float32Array(N);

  // cluster centers spread evenly on a sphere (golden-angle spiral -> balanced, centered)
  const centers=[]; const golden=Math.PI*(3-Math.sqrt(5));
  for(let k=0;k<CLUSTERS;k++){
    const y=1-(k/(CLUSTERS-1))*2;            // -1..1
    const r=Math.sqrt(1-y*y), th=golden*k, rad=1.7;
    centers.push([Math.cos(th)*r*rad, y*rad*0.82, Math.sin(th)*r*rad]);
  }
  for(let i=0;i<N;i++){
    const k=(Math.random()*CLUSTERS)|0, c=centers[k];
    const spread = 0.28 + Math.random()*0.34;
    target[i*3]   = c[0]+gauss(spread);
    target[i*3+1] = c[1]+gauss(spread);
    target[i*3+2] = c[2]+gauss(spread);
    // start scattered on a big shell for the "assemble" intro
    const a=Math.random()*Math.PI*2, b=Math.acos(2*Math.random()-1), r=5+Math.random()*4;
    scatter[i*3]   = r*Math.sin(b)*Math.cos(a);
    scatter[i*3+1] = r*Math.cos(b);
    scatter[i*3+2] = r*Math.sin(b)*Math.sin(a);
    const col=PAL[k%PAL.length], v=0.75+Math.random()*0.45;
    color[i*3]=col[0]*v; color[i*3+1]=col[1]*v; color[i*3+2]=col[2]*v;
    rand[i]=Math.random();
  }
  g.setAttribute('aTarget', new THREE.BufferAttribute(target,3));
  g.setAttribute('aScatter',new THREE.BufferAttribute(scatter,3));
  g.setAttribute('aColor',  new THREE.BufferAttribute(color,3));
  g.setAttribute('aRand',   new THREE.BufferAttribute(rand,1));
  g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(N*3),3)); // required slot
  return g;
}

const VERT = `
  uniform float uTime, uProgress, uBurst, uSize, uPixel, uPulse;
  attribute vec3 aTarget, aScatter, aColor; attribute float aRand;
  varying vec3 vColor; varying float vAlpha;
  void main(){
    float p = uProgress;
    vec3 pos = mix(aScatter, aTarget, p);
    float t = uTime*0.28 + aRand*6.2831;
    float amp = 0.05 + uPulse*0.55;
    pos.x += sin(t)*amp;
    pos.y += cos(t*1.1)*amp;
    pos.z += sin(t*0.7)*amp;
    pos += normalize(aTarget+0.0001) * uBurst * (3.5 + aRand*4.0);
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(pos,1.0);
    float size = uSize*(0.55+aRand*0.9)*(1.0+uPulse*0.6);
    gl_PointSize = size * uPixel * (1.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
    vAlpha = 1.0 - uBurst;
  }`;
const FRAG = `
  precision mediump float;
  varying vec3 vColor; varying float vAlpha;
  void main(){
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = pow(smoothstep(0.5,0.0,d), 1.5);
    float core = smoothstep(0.16,0.0,d);
    vec3 col = vColor + core*0.6;
    gl_FragColor = vec4(col, a*vAlpha);
    if(gl_FragColor.a < 0.01) discard;
  }`;

function buildScene(){
  renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true});
  // Capped at 1, not devicePixelRatio. This gate is purely fill-rate bound:
  // measured on an M2, 6.7MP ran at 31fps, 2.5MP still dropped 13 frames in 192,
  // and 1.6MP holds a locked 60 with 2. The particle count was never the
  // problem. Soft additive blobs gain almost nothing from extra density, and a
  // steady 60 is worth far more than crisper points, especially since a weaker
  // machine than this one would fare worse.
  renderer.setPixelRatio(Math.min(devicePixelRatio,1));
  renderer.setSize(innerWidth,innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x191410, 0.12);

  camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 100);
  camera.position.set(0,0,6.4);

  mat = new THREE.ShaderMaterial({
    uniforms:{ uTime:{value:0}, uProgress:{value:0}, uBurst:{value:0},
               uSize:{value:15.0}, uPixel:{value:Math.min(devicePixelRatio,1)}, uPulse:{value:0} },
    vertexShader:VERT, fragmentShader:FRAG,
    transparent:true, depthWrite:false, blending:THREE.AdditiveBlending
  });

  group = new THREE.Group();
  points = new THREE.Points(buildPoints(), mat);
  points.frustumCulled=false;
  group.add(points); scene.add(group);
}

const easeOut = t => 1-Math.pow(1-t,3);

function tick(){
  if(!running) return;
  try{
    const t=(performance.now()-startT)/1000;
    mat.uniforms.uTime.value = t;
    // assemble over 1.8s
    mat.uniforms.uProgress.value = Math.min(easeOut(t/1.8), 1);
    // click pulse decays
    pulse *= 0.94; mat.uniforms.uPulse.value = pulse;

    // parallax: ease group rotation toward cursor, plus slow auto-spin
    rot.x += (rotTarget.x - rot.x)*0.05;
    rot.y += (rotTarget.y - rot.y)*0.05;
    group.rotation.x = rot.x;
    group.rotation.y = rot.y + t*0.08;

    renderer.render(scene,camera);
    raf=requestAnimationFrame(tick);
  }catch(err){
    console.error('particle gate crashed, revealing page:',err);
    finish(); document.body.classList.add('reveal');
  }
}

function reveal(){
  if(leaving) return; leaving=true;
  gate.classList.add('leaving');
  // burst the points outward, then fade the gate + build the page
  const t0=performance.now();
  (function burst(){
    const k=Math.min((performance.now()-t0)/900,1);
    if(mat) mat.uniforms.uBurst.value = easeOut(k);
    if(k<1 && running){ requestAnimationFrame(burst); }
  })();
  timers.push(setTimeout(()=>{ document.body.classList.add('reveal'); }, 500));
  timers.push(setTimeout(()=>{ gate.classList.add('done'); }, 650));
  timers.push(setTimeout(finish, 1250));
}

function finish(){
  running=false; if(raf)cancelAnimationFrame(raf);
  gate.style.display='none'; replay.hidden=false;
  if(renderer) renderer.dispose();
}

function start(){
  try{
    document.body.classList.add('cinema'); document.body.classList.remove('reveal');
    gate.style.display=''; gate.classList.remove('done','leaving');
    copy.classList.remove('show'); hint.classList.remove('show');
    replay.hidden=true; leaving=false; pulse=0; rot={x:0,y:0}; rotTarget={x:0,y:0};

    if(renderer) renderer.dispose();
    buildScene();
    startT=performance.now(); running=true;
    raf=requestAnimationFrame(tick);
    timers.push(setTimeout(()=>copy.classList.add('show'), 700));
    timers.push(setTimeout(()=>hint.classList.add('show'), 1400));
  }catch(err){
    console.error('3D gate failed, skipping to page:',err);
    running=false; document.body.classList.add('cinema','reveal');
    gate.style.display='none'; replay.hidden=false;
  }
}

// ---- interaction ----
function onMove(cx,cy){
  mouse.x=(cx/innerWidth)*2-1; mouse.y=(cy/innerHeight)*2-1;
  rotTarget.y = mouse.x*0.5;
  rotTarget.x = mouse.y*0.35;
}
addEventListener('mousemove',e=>onMove(e.clientX,e.clientY));
addEventListener('touchmove',e=>{ if(e.touches[0]) onMove(e.touches[0].clientX,e.touches[0].clientY); },{passive:true});
canvas.addEventListener('pointerdown',()=>{ pulse=1; });

enterB.addEventListener('click',reveal);
skipB.addEventListener('click',()=>{ // skip = instant, no burst
  timers.forEach(clearTimeout); timers=[];
  running=false; if(raf)cancelAnimationFrame(raf);
  document.body.classList.add('cinema','reveal'); gate.classList.add('done');
  setTimeout(()=>{ gate.style.display='none'; replay.hidden=false; if(renderer)renderer.dispose(); },500);
});
replay.addEventListener('click',start);

addEventListener('resize',()=>{
  if(!renderer)return;
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
  mat.uniforms.uPixel.value=Math.min(devicePixelRatio,1);
});

if(RM){ gate.style.display='none'; document.body.classList.add('cinema','reveal'); replay.hidden=false; }
else { start(); }
