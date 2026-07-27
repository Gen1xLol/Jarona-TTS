'use strict';

self.onmessage = async function handleMessage(e) {
  const msg = e.data;
  if (!msg || msg.type !== 'render') return;

  const { requestId, sampleRate, totalDuration, timedPlan, clipBuffers } = msg;

  try {
    const result = renderPlanInWorker({ sampleRate, totalDuration, timedPlan, clipBuffers });
    self.postMessage(
      {
        type: 'rendered',
        requestId,
        channelData: result.channelData,
        length: result.length,
        sampleRate: result.sampleRate,
      },
      [result.channelData.buffer]
    );
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId,
      message: (err && err.message) || String(err),
    });
  }
};

function makeBiquad(type, sampleRate, freq, opts) {
  opts = opts || {};
  const Q = opts.Q || 0.707;
  const gainDb = opts.gainDb || 0;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);

  let b0, b1, b2, a0, a1, a2;

  if (type === 'highpass') {
    b0 = (1 + cosw0) / 2;
    b1 = -(1 + cosw0);
    b2 = (1 + cosw0) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw0;
    a2 = 1 - alpha;
  } else if (type === 'lowshelf') {
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) - (A - 1) * cosw0 + twoSqrtAAlpha);
    b1 = 2 * A * ((A - 1) - (A + 1) * cosw0);
    b2 = A * ((A + 1) - (A - 1) * cosw0 - twoSqrtAAlpha);
    a0 = (A + 1) + (A - 1) * cosw0 + twoSqrtAAlpha;
    a1 = -2 * ((A - 1) + (A + 1) * cosw0);
    a2 = (A + 1) + (A - 1) * cosw0 - twoSqrtAAlpha;
  } else if (type === 'peaking') {
    b0 = 1 + alpha * A;
    b1 = -2 * cosw0;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosw0;
    a2 = 1 - alpha / A;
  } else {
    throw new Error('unknown biquad type: ' + type);
  }

  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
    a1: a1 / a0, a2: a2 / a0,
    x1: 0, x2: 0, y1: 0, y2: 0,
  };
}

function applyBiquadInPlace(data, coef) {
  let { b0, b1, b2, a1, a2, x1, x2, y1, y2 } = coef;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    data[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  coef.x1 = x1; coef.x2 = x2;
  coef.y1 = y1; coef.y2 = y2;
}

function applyCompressorInPlace(data, sampleRate, opts) {
  const thresholdDb = opts.thresholdDb;
  const kneeDb = opts.kneeDb;
  const ratio = opts.ratio;
  const attackSec = opts.attackSec;
  const releaseSec = opts.releaseSec;

  const attackCoef = Math.exp(-1 / (sampleRate * attackSec));
  const releaseCoef = Math.exp(-1 / (sampleRate * releaseSec));

  let envDb = -100;

  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const inputDb = 20 * Math.log10(Math.max(Math.abs(x), 1e-8));

    const coef = inputDb > envDb ? attackCoef : releaseCoef;
    envDb = coef * envDb + (1 - coef) * inputDb;

    let gainReductionDb = 0;
    const kneeStart = thresholdDb - kneeDb / 2;
    const kneeEnd = thresholdDb + kneeDb / 2;

    if (envDb > kneeEnd) {
      gainReductionDb = (envDb - thresholdDb) * (1 - 1 / ratio);
    } else if (envDb > kneeStart && kneeDb > 0) {
      const t = (envDb - kneeStart) / kneeDb;
      const softDb = (envDb - thresholdDb + kneeDb / 2) * t * 0.5 * (1 - 1 / ratio);
      gainReductionDb = softDb;
    }

    const gain = Math.pow(10, -gainReductionDb / 20);
    data[i] = x * gain;
  }
}

function renderPlanInWorker({ sampleRate, totalDuration, timedPlan, clipBuffers }) {
  const SAFETY_PAD_SECONDS = 0.15;
  const safeDuration = totalDuration > 0 ? totalDuration : 0.05;
  const totalFrames = Math.ceil((safeDuration + SAFETY_PAD_SECONDS) * sampleRate);

  const mixBuffer = new Float32Array(totalFrames);

  timedPlan.forEach((item, idx) => {
    if (item.kind !== 'clip') return;

    const clip = clipBuffers[item.clipId];
    if (!clip) return;

    const rawData = clip.channelData;
    const startFrame = item.trimStart;
    const endFrame = item.trimEnd;
    const sourceOffset = startFrame;
    const numFrames = Math.max(1, endFrame - startFrame);

    const nextItem = timedPlan[idx + 1];
    const hasNextOverlap =
      nextItem && nextItem.kind === 'clip' && nextItem.wordIndex === item.wordIndex && nextItem.overlapPrev > 0;
    const overlapNext = hasNextOverlap ? nextItem.overlapPrev : 0;

    const fadeInSec = item.overlapPrev > 0 ? item.overlapPrev : 0.004;
    const fadeOutSec = overlapNext > 0 ? overlapNext : 0.004;

    const fadeInFrames = Math.min(Math.floor(numFrames / 2), Math.round(fadeInSec * sampleRate));
    const fadeOutFrames = Math.min(Math.floor(numFrames / 2), Math.round(fadeOutSec * sampleRate));

    const startSampleIdx = Math.round(item.start * sampleRate);

    for (let f = 0; f < numFrames; f++) {
      let val = rawData[sourceOffset + f] * item.gainScale;

      if (f < fadeInFrames && fadeInFrames > 0) {
        if (item.overlapPrev > 0) {
          val *= Math.sin((Math.PI / 2) * (f / fadeInFrames));
        } else {
          val *= f / fadeInFrames;
        }
      }

      const framesFromEnd = numFrames - 1 - f;
      if (framesFromEnd < fadeOutFrames && fadeOutFrames > 0) {
        if (overlapNext > 0) {
          val *= Math.cos((Math.PI / 2) * (1 - framesFromEnd / fadeOutFrames));
        } else {
          val *= framesFromEnd / fadeOutFrames;
        }
      }

      const outIdx = startSampleIdx + f;
      if (outIdx >= 0 && outIdx < mixBuffer.length) {
        mixBuffer[outIdx] += val;
      }
    }
  });

  const highPass = makeBiquad('highpass', sampleRate, 70);
  const lowShelf = makeBiquad('lowshelf', sampleRate, 180, { gainDb: 1.5 });
  const presence = makeBiquad('peaking', sampleRate, 1500, { Q: 1.2, gainDb: 2.0 });

  applyBiquadInPlace(mixBuffer, highPass);
  applyBiquadInPlace(mixBuffer, lowShelf);
  applyBiquadInPlace(mixBuffer, presence);

  applyCompressorInPlace(mixBuffer, sampleRate, {
    thresholdDb: -14,
    kneeDb: 10,
    ratio: 3.5,
    attackSec: 0.003,
    releaseSec: 0.1,
  });

  const exactFrames = Math.min(Math.ceil(safeDuration * sampleRate), mixBuffer.length);
  const length = Math.max(exactFrames, 1);
  const channelData = new Float32Array(length);
  channelData.set(mixBuffer.subarray(0, length));

  return { channelData, length, sampleRate };
}
