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

// ── the tear ───────────────────────────────────────────────────────────────
// The front page rips horizontally across the middle and the halves slide
// apart, revealing the layer behind. Two clipped copies of the sheet are what
// makes that possible: a single element cannot be split into two pieces that
// move independently.
//
// The clone is built here rather than in the HTML on purpose. The markup ships
// one copy, so a crawler and a screen reader see one masthead, one headline and
// one contents list; the duplicate exists only in the DOM at runtime, is marked
// aria-hidden, and has every id stripped so nothing ends up duplicated.
(function () {
  const zone = document.getElementById('tearzone');
  const stage = document.getElementById('tearstage');
  const sheet = document.querySelector('[data-sheet]');
  const back = document.getElementById('tearback');
  if (!zone || !stage || !sheet || !back) return;

  if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;

  // A torn paper edge, not a cut: the fibres wander a few percent either side
  // of the midline in irregular steps. Regenerated per load so it is never
  // quite the same rip twice.
  function tornEdge(steps = 46, mid = 49, spread = 2.4) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * 100;
      // Two offset sines plus jitter reads more like fibre than pure noise,
      // which comes out looking like static.
      const wave =
        Math.sin(i * 0.9) * spread * 0.42 +
        Math.sin(i * 2.7 + 1.3) * spread * 0.28 +
        (Math.random() - 0.5) * spread * 0.75;
      pts.push([x, +(mid + wave).toFixed(2)]);
    }
    return pts;
  }

  const edge = tornEdge();
  const topPoly = `polygon(0% 0%, 100% 0%, ${edge
    .slice()
    .reverse()
    .map(([x, y]) => `${x}% ${y}%`)
    .join(', ')})`;
  const botPoly = `polygon(${edge.map(([x, y]) => `${x}% ${y}%`).join(', ')}, 100% 100%, 0% 100%)`;

  // Build the halves. The original becomes the top; the clone becomes the
  // bottom and is stripped of anything that must stay unique.
  const clone = sheet.cloneNode(true);
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  clone.querySelectorAll('a, button, input').forEach((el) => el.setAttribute('tabindex', '-1'));
  // The clone is decoration. Its animated canvas and film grain would double the
  // per-frame cost of the most expensive thing on the page for no visible gain,
  // since most of it sits behind the tear.
  clone.querySelectorAll('canvas').forEach((el) => el.remove());
  clone.classList.add('nograin');

  // The tear cuts through the portrait, so the halves show the top and bottom of
  // the same face. Two <video> elements started independently drift apart within
  // seconds, and a face whose jaw moves out of step with its eyes is worse than
  // no motion at all. The clone is slaved to the original and nudged back
  // whenever it strays past a few frames.
  const lead = sheet.querySelector('.plate-video');
  const follow = clone.querySelector('.plate-video');
  if (lead && follow) {
    follow.muted = true;
    const resync = () => {
      if (lead.readyState < 2 || follow.readyState < 2) return;
      if (Math.abs(follow.currentTime - lead.currentTime) > 0.08) {
        follow.currentTime = lead.currentTime;
      }
    };
    lead.addEventListener('play', () => { follow.play().catch(() => {}); resync(); });
    lead.addEventListener('seeked', resync);
    // The last frame is the one that stays on screen, so it has to match.
    lead.addEventListener('ended', () => {
      follow.pause();
      follow.currentTime = lead.duration - 0.001;
    });
    // Cheap and infrequent: drift accumulates slowly, and correcting it every
    // frame would cost more than the mismatch it fixes.
    setInterval(resync, 500);
    if (!lead.paused) { follow.play().catch(() => {}); }
  }

  sheet.classList.add('sheethalf', 'live');
  clone.classList.add('sheethalf');
  sheet.style.clipPath = topPoly;
  clone.style.clipPath = botPoly;
  stage.appendChild(clone);

  let ticking = false;
  let torn = false;
  function update() {
    const rect = zone.getBoundingClientRect();
    // 0 while the sheet is still arriving, 1 once the runway is spent.
    const travel = zone.offsetHeight - window.innerHeight;
    const t = Math.max(0, Math.min(1, -rect.top / travel));

    // Nothing happens for the first fifth: the reader gets to actually read the
    // front page before it comes apart.
    const rip = Math.max(0, (t - 0.2) / 0.8);
    const eased = rip * rip * (3 - 2 * rip); // smoothstep

    sheet.style.transform = `translate3d(0, ${-eased * 62}vh, 0)`;
    clone.style.transform = `translate3d(0, ${eased * 62}vh, 0)`;
    // The halves are lit from the tear, so they dim slightly as they leave.
    const fade = 1 - eased * 0.25;
    sheet.style.opacity = clone.style.opacity = fade.toFixed(3);
    back.style.setProperty('--reveal', Math.min(1, eased * 1.9).toFixed(3));

    // The rocket waits for this. Fired once the paper is essentially fully
    // parted, so the arrival happens in the world the tear opened rather than
    // over the top of the page still tearing.
    if (!torn && eased > 0.96) {
      torn = true;
      dispatchEvent(new CustomEvent('portfolio:tearcomplete'));
    }
  }

  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { update(); ticking = false; });
  }, { passive: true });
  addEventListener('resize', update, { passive: true });
  update();
})();

// ── tear sound ─────────────────────────────────────────────────────────────
// Synthesised, not a file: a paper rip is filtered noise with a fast attack and
// a ragged amplitude, which Web Audio makes cheaply and which costs no request.
//
// Two constraints shape this. Browsers refuse audio until the user has
// interacted, so the context is only created after the first gesture (entering
// or skipping the intro both count). And unexpected sound on a portfolio
// irritates as often as it delights, so it is off until asked for and the
// toggle is remembered.
(function () {
  const zone = document.getElementById('tearzone');
  if (!zone) return;

  const KEY = 'ajay.tearSound';
  let enabled = localStorage.getItem(KEY) === 'on';
  let ctx = null;
  let noiseBuf = null;
  let lastAt = 0;
  let lastProgress = 0;

  const btn = document.createElement('button');
  btn.className = 'soundtoggle';
  btn.type = 'button';
  render();
  document.body.appendChild(btn);

  function render() {
    btn.textContent = enabled ? '♪ sound on' : '♪ sound off';
    btn.setAttribute('aria-pressed', String(enabled));
    btn.setAttribute('aria-label', enabled ? 'Turn tear sound off' : 'Turn tear sound on');
  }

  btn.addEventListener('click', () => {
    enabled = !enabled;
    localStorage.setItem(KEY, enabled ? 'on' : 'off');
    render();
    if (enabled) { prime(); rip(0.5); }   // confirm the choice audibly
  });

  // Any genuine gesture unlocks audio; scroll alone does not count, which is why
  // the toggle could read "on" and still be silent.
  ['pointerdown', 'keydown', 'touchstart'].forEach((evt) =>
    addEventListener(evt, () => { if (enabled) prime(); }, { passive: true })
  );

  function prime() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    // Two seconds of white noise, reused for every rip.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // One short rip. `force` (0-1) comes from how fast the reader is scrolling,
  // so a slow drag whispers and a flick actually tears.
  function rip(force) {
    if (!enabled || !ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;

    // Paper is mostly high-mid; the bandpass is what stops it sounding like static.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2100 + Math.random() * 1600;
    band.Q.value = 0.7;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;

    const gain = ctx.createGain();
    const peak = Math.min(0.16, 0.03 + force * 0.15);
    const dur = 0.07 + force * 0.1;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(band); band.connect(hp); hp.connect(gain); gain.connect(ctx.destination);
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  // Driven from the same scroll progress the tear uses, but throttled: a rip is
  // a burst of many small fibre snaps, not one continuous tone.
  addEventListener('scroll', () => {
    if (!enabled) return;
    prime();
    const rect = zone.getBoundingClientRect();
    const travel = zone.offsetHeight - window.innerHeight;
    const t = Math.max(0, Math.min(1, -rect.top / travel));
    const progress = Math.max(0, (t - 0.2) / 0.8);
    if (progress <= 0 || progress >= 1) { lastProgress = progress; return; }

    const delta = Math.abs(progress - lastProgress);
    const now = performance.now();
    if (delta > 0.004 && now - lastAt > 38) {
      lastAt = now;
      rip(Math.min(1, delta * 22));
    }
    lastProgress = progress;
  }, { passive: true });
})();

// ── entering the portfolio ─────────────────────────────────────────────────
// Everything expensive waits for this: the portrait, the earth texture, and the
// audio context. Previously the video played the moment the script ran, which
// meant its 6.6 seconds elapsed behind the gate and it had already stopped by
// the time anyone saw it, while its decode competed with the intro's frames.
(function () {
  const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
  let entered = false;

  // One listener for all the plates, replaced rather than stacked, so a repeated
  // refusal cannot pile up handlers on the document.
  let retryArmed = false;
  function armRetry() {
    if (retryArmed) return;
    retryArmed = true;
    const events = ['touchstart', 'pointerdown'];
    const go = () => {
      retryArmed = false;
      events.forEach((evt) => removeEventListener(evt, go));
      document.querySelectorAll('.plate-video').forEach((el) => {
        el.muted = true;
        el.play().catch(() => {});
      });
    };
    events.forEach((evt) => addEventListener(evt, go, { passive: true }));
  }

  // The hero is on screen about a second before the gate finishes unmounting,
  // and the fetch used to start only after that. So the plate sat on its poster,
  // then swapped to video once the bytes arrived: the hitch. Start the fetch as
  // the gate begins to leave, and only call play() on entry. Deliberately not at
  // page load -- that was the original bug, where the clip ran out behind the
  // gate and its decode fought the intro for frames.
  let warmed = false;
  function warmPortrait() {
    if (warmed || reduced) return;
    warmed = true;
    document.querySelectorAll('.plate-video').forEach((v) => {
      v.muted = true;
      if (v.readyState === 0) v.load();
    });
  }

  // body.reveal lands when the gate starts handing the page over.
  if (document.body.classList.contains('reveal')) warmPortrait();
  else {
    const bodyWatch = new MutationObserver(() => {
      if (document.body.classList.contains('reveal')) { bodyWatch.disconnect(); warmPortrait(); }
    });
    bodyWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  function playPortrait() {
    if (reduced) return;
    document.querySelectorAll('.plate-video').forEach((v) => {
      v.muted = true;

      // Wait for metadata before starting: play() on a video with no known
      // dimensions yields a 0x0 frame and silently does nothing. Cheap now that
      // the file is fast-start, and free when warmPortrait already fetched it.
      // If play() is refused the poster stays up and the visitor just sees a
      // still, with nothing to tell them otherwise. Refusal is normal on a
      // phone -- iOS blocks autoplay outright in Low Power Mode, muted and
      // inline or not -- so the retry is armed on the next touch, which is a
      // gesture the policy does accept.
      const start = () => {
        v.currentTime = 0;
        const p = v.play();
        if (p && p.catch) p.catch(() => armRetry());
        // A rejected promise is not the only way autoplay fails, and testing
        // showed it is not even the common one: play() can resolve and the
        // video simply never advances. So the check is whether it actually
        // moved, not whether the call claimed to succeed.
        setTimeout(() => { if (v.paused) armRetry(); }, 400);
      };
      if (v.readyState >= 1) start();
      else {
        v.addEventListener('loadedmetadata', start, { once: true });
        v.load();   // preload is "none", so nothing is fetched until here
      }
    });
  }

  function enter() {
    if (entered) return;
    entered = true;
    document.body.classList.add('entered');   // lets the earth texture paint
    // A plain timer, not requestAnimationFrame: rAF is frozen while a tab is in
    // the background, so chaining the portrait behind it meant a page opened in
    // a background tab never started its video at all. The delay still gives the
    // gate's teardown room to paint before the decode competes with it.
    setTimeout(playPortrait, 300);
  }

  // The gate signals completion by unhiding the replay button on every exit
  // path, so watching that catches enter, skip and the reduced-motion path
  // without reaching into intro.js.
  const replay = document.getElementById('replay');
  if (!replay || !replay.hidden) enter();
  else {
    const mo = new MutationObserver(() => { if (!replay.hidden) { mo.disconnect(); enter(); } });
    mo.observe(replay, { attributes: true, attributeFilter: ['hidden'] });
    setTimeout(() => { mo.disconnect(); enter(); }, 12000);  // never strand the page
  }

  // Scrolling back up closes the tear. Reaching the top again is a return to the
  // front page, so the portrait plays once more rather than sitting on a frozen
  // last frame.
  const zone = document.getElementById('tearzone');
  if (zone) {
    let wasOpen = false;
    addEventListener('scroll', () => {
      const t = -zone.getBoundingClientRect().top / (zone.offsetHeight - innerHeight);
      const open = t > 0.35;
      if (wasOpen && !open && entered) playPortrait();
      wasOpen = open;
    }, { passive: true });
  }
})();
