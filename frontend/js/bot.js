(function () {
  const NS = "http://www.w3.org/2000/svg";
  const host = document.createElement("div");
  host.className = "host";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.setAttribute("aria-hidden", "true");
  const balls = document.createElementNS(NS, "g");
  const body = document.createElementNS(NS, "g");
  const blob = document.createElementNS(NS, "path");
  blob.setAttribute("fill", "#f3efe6");
  const eyeL = document.createElementNS(NS, "ellipse");
  const eyeR = document.createElementNS(NS, "ellipse");
  eyeL.setAttribute("fill", "#1a1916");
  eyeR.setAttribute("fill", "#1a1916");
  body.appendChild(blob);
  body.appendChild(eyeL);
  body.appendChild(eyeR);
  svg.appendChild(balls);
  svg.appendChild(body);
  host.appendChild(svg);
  document.body.appendChild(host);

  const colors = ["#f4c34e", "#f9705c", "#5b95f0", "#3fbe86", "#9a72ee"];
  const ballEls = colors.map(function (color) {
    const node = document.createElementNS(NS, "circle");
    node.setAttribute("r", "5.5");
    node.setAttribute("fill", color);
    balls.appendChild(node);
    return node;
  });

  function Spring(value) {
    this.x = value;
    this.v = 0;
    this.t = value;
  }
  Spring.prototype.step = function (freq, damp, dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      this.v += (-2 * damp * freq * this.v - freq * freq * (this.x - this.t)) * h;
      this.x += this.v * h;
    }
  };

  const posX = new Spring(window.innerWidth * 0.72);
  const posY = new Spring(window.innerHeight * 0.42);
  const size = new Spring(280);
  const lookX = new Spring(0);
  const lookY = new Spring(0);
  const squash = new Spring(1);
  const stretch = new Spring(1);
  const blink = new Spring(1);
  const spread = new Spring(34);
  const hop = new Spring(0);
  let pointerX = window.innerWidth / 2;
  let pointerY = window.innerHeight * 0.4;
  let nextBlink = performance.now() + 1600;
  let resting = true;

  function rest() {
    if (!resting) return;
    squash.t = 1;
    stretch.t = 1;
    hop.t = 0;
    spread.t = 34;
  }
  window.addEventListener("pointermove", function (event) {
    pointerX = event.clientX;
    pointerY = event.clientY;
    const over = event.target.closest && event.target.closest("a, button");
    if (over) {
      spread.t = 48;
      squash.t = 1.06;
      stretch.t = 0.94;
      resting = false;
    } else {
      resting = true;
      rest();
    }
  });
  svg.addEventListener("pointerdown", function (event) {
    event.preventDefault();
    resting = false;
    squash.t = 1.22;
    stretch.t = 0.78;
    hop.t = -14;
    spread.t = 64;
    window.setTimeout(function () {
      resting = true;
      rest();
    }, 220);
  });

  function blobPath(sx, sy, wobble) {
    const n = 32;
    let d = "";
    for (let i = 0; i < n; i += 1) {
      const angle = (i / n) * Math.PI * 2;
      const wave = 1 + Math.sin(angle * 3 + wobble) * 0.03 + Math.cos(angle * 5 - wobble * 0.7) * 0.015;
      const x = 100 + Math.cos(angle) * 58 * sx * wave;
      const y = 100 + Math.sin(angle) * 58 * sy * wave;
      d += (i ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2);
    }
    return d + "Z";
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.034, (now - last) / 1000);
    last = now;
    const stage = document.getElementById("bot-stage");
    const box = stage ? stage.getBoundingClientRect() : null;
    if (box && box.bottom > 120 && box.top < window.innerHeight) {
      posX.t = box.left + box.width / 2;
      posY.t = box.top + box.height / 2;
      size.t = Math.min(box.width, box.height);
    } else {
      posX.t = window.innerWidth - 58;
      posY.t = window.innerHeight - 58;
      size.t = 104;
    }
    if (now > nextBlink) {
      blink.t = 0.08;
      window.setTimeout(function () { blink.t = 1; }, 110);
      nextBlink = now + 1800 + Math.random() * 2600;
    }
    const dx = pointerX - posX.x;
    const dy = pointerY - posY.y;
    const dist = Math.hypot(dx, dy) || 1;
    lookX.t = Math.max(-1, Math.min(1, dx / 280));
    lookY.t = Math.max(-1, Math.min(1, dy / 280));
    posX.step(9, 0.72, dt);
    posY.step(9, 0.72, dt);
    size.step(8, 0.8, dt);
    lookX.step(14, 0.7, dt);
    lookY.step(14, 0.7, dt);
    squash.step(16, 0.55, dt);
    stretch.step(16, 0.55, dt);
    blink.step(22, 0.7, dt);
    spread.step(8, 0.62, dt);
    hop.step(12, 0.48, dt);
    host.style.left = posX.x + "px";
    host.style.top = (posY.x + hop.x) + "px";
    host.style.width = size.x + "px";
    host.style.height = size.x + "px";
    const wobble = now / 700;
    blob.setAttribute("d", blobPath(squash.x, stretch.x, wobble));
    body.setAttribute("transform", "rotate(" + (lookX.x * 6).toFixed(2) + " 100 100)");
    const eyes = [
      [78 + lookX.x * 7, 96 + lookY.x * 5, eyeL],
      [122 + lookX.x * 7, 96 + lookY.x * 5, eyeR]
    ];
    eyes.forEach(function (eye) {
      eye[2].setAttribute("cx", eye[0].toFixed(2));
      eye[2].setAttribute("cy", eye[1].toFixed(2));
      eye[2].setAttribute("rx", "7.2");
      eye[2].setAttribute("ry", (8.4 * Math.max(0.08, blink.x)).toFixed(2));
    });
    ballEls.forEach(function (node, index) {
      const angle = now / 880 + index * (Math.PI * 2 / ballEls.length);
      const radius = spread.x + Math.sin(now / 360 + index) * 2.4;
      node.setAttribute("cx", (100 + Math.cos(angle) * radius).toFixed(2));
      node.setAttribute("cy", (100 + Math.sin(angle) * radius * 0.7).toFixed(2));
    });
    if (dist < 70 && size.x > 140) spread.t = Math.max(spread.t, 42);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
