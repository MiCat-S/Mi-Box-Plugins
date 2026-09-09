let canvasModule: any;

async function tryGetCanvas(): Promise<any> {
  if (canvasModule !== undefined) return canvasModule;
  try {
    const moduleName = "canvas";
    canvasModule = await import(moduleName);
  } catch { canvasModule = null; }
  return canvasModule;
}

export async function generateImageCaptcha(
  digitOnly: boolean
): Promise<{ buffer: Buffer; answer: string } | null> {
  const cv = await tryGetCanvas();
  if (!cv) return null;

  const CHARSET_DIGIT = "0123456789";
  const CHARSET_MIXED = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const charset = digitOnly ? CHARSET_DIGIT : CHARSET_MIXED;
  const LENGTH  = 5;

  let answer = "";
  for (let i = 0; i < LENGTH; i++) {
    answer += charset[Math.floor(Math.random() * charset.length)];
  }

  const W = 240, H = 90;
  const canvas = cv.createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  const rnd  = () => Math.random();
  const rndI = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;

  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = `hsla(${rndI(0,360)},30%,${rndI(85,97)}%,0.9)`;
    ctx.fillRect(rndI(0, W), rndI(0, H), rndI(20, 80), rndI(20, 60));
  }

  ctx.strokeStyle = `rgba(180,180,200,0.35)`;
  ctx.lineWidth = 0.8;
  for (let x = 0; x < W; x += rndI(18, 28)) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += rndI(18, 28)) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.moveTo(0, rnd() * H);
    ctx.bezierCurveTo(W * 0.25, rnd() * H, W * 0.75, rnd() * H, W, rnd() * H);
    ctx.strokeStyle = `hsla(${rndI(0,360)},55%,45%,${0.3 + rnd() * 0.3})`;
    ctx.lineWidth   = 1 + rnd();
    ctx.stroke();
  }

  for (let i = 0; i < 180; i++) {
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, 0.8 + rnd() * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${rndI(0,360)},50%,35%,${0.4 + rnd() * 0.4})`;
    ctx.fill();
  }

  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = `hsla(${rndI(0,360)},60%,60%,0.15)`;
    ctx.fillRect(rnd() * W, rnd() * H, rndI(8, 30), rndI(4, 16));
  }

  const STEP = (W - 24) / LENGTH;
  for (let i = 0; i < LENGTH; i++) {
    const ch  = answer[i];
    const x   = 14 + i * STEP + STEP * 0.35;
    const y   = H / 2 + (rnd() - 0.5) * 18;
    const rot = (rnd() - 0.5) * 0.65;
    const sz  = 32 + rndI(0, 10);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.font         = `bold ${sz}px monospace`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor   = `hsla(${rndI(0,360)},80%,50%,0.6)`;
    ctx.shadowBlur    = 4;
    ctx.strokeStyle   = `hsla(${rndI(0,360)},35%,85%,0.9)`;
    ctx.lineWidth     = 4;
    ctx.strokeText(ch, 0, 0);

    ctx.shadowBlur  = 0;
    ctx.fillStyle   = `hsl(${rndI(0,360)},70%,20%)`;
    ctx.fillText(ch, 0, 0);

    if (rnd() > 0.5) {
      ctx.strokeStyle = `hsla(${rndI(0,360)},60%,40%,0.5)`;
      ctx.lineWidth   = 1.5;
      const hw = sz * 0.35;
      ctx.beginPath();
      ctx.moveTo(-hw, (rnd() - 0.5) * sz * 0.4);
      ctx.lineTo( hw, (rnd() - 0.5) * sz * 0.4);
      ctx.stroke();
    }

    ctx.restore();
  }

  return { buffer: canvas.toBuffer("image/png"), answer };
}

