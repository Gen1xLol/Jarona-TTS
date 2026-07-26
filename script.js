  'use strict';

  const LIBRARY_ROOT_EN = 'phoneme_library/';
  const MANIFEST_URL_EN = LIBRARY_ROOT_EN + 'manifest.json';
  const LIBRARY_ROOT_JP = 'phoneme_library_japanese/';
  const MANIFEST_URL_JP = LIBRARY_ROOT_JP + 'manifest.json';
  const CMUDICT_URL = 'cmudict_full.json';
  const LOCALSTORAGE_KEY_JP = 'jarona_tts_use_jp';

  const WORD_GAP = 0.038;

  const PHONEME_GAP = 0.002;

  const PAUSE_PUNCT = { '.': 0.28, '!': 0.28, '?': 0.3, ',': 0.16, ';': 0.2, ':': 0.2 };

  const els = {
    editable: document.getElementById('editable'),
    playBtn: document.getElementById('playBtn'),
    stopBtn: document.getElementById('stopBtn'),
    exportBtn: document.getElementById('exportBtn'),
    clearBtn: document.getElementById('clearBtn'),
    jpToggle: document.getElementById('jpToggle'),
    loadStatus: document.getElementById('loadStatus'),
    statusLine: document.getElementById('statusLine'),
    hudFileName: document.getElementById('hudFileName'),
    hudOrigin: document.getElementById('hudOrigin'),
    enRatioText: document.getElementById('enRatioText'),
    jpRatioText: document.getElementById('jpRatioText'),
    ratioBarEn: document.getElementById('ratioBarEn'),
    ratioBarJp: document.getElementById('ratioBarJp'),
  };

  let useJpVoicelines = true;
  const storedJpSetting = localStorage.getItem(LOCALSTORAGE_KEY_JP);
  if (storedJpSetting !== null) {
    try {
      useJpVoicelines = JSON.parse(storedJpSetting);
    } catch (e) {
      useJpVoicelines = true;
    }
  }
  els.jpToggle.checked = useJpVoicelines;

  function setStatus(msg, kind) {
    els.statusLine.textContent = msg || '\u00A0';
    els.statusLine.classList.remove('err', 'ok');
    if (kind) els.statusLine.classList.add(kind);
  }

  function resetHudAndRatio() {
    els.hudFileName.textContent = 'CLIP: IDLE';
    els.hudOrigin.textContent = '[---]';
    els.hudOrigin.className = 'origin-tag';
    els.enRatioText.textContent = 'EN AUDIO: 0%';
    els.jpRatioText.textContent = 'JP AUDIO: 0%';
    els.ratioBarEn.style.width = '50%';
    els.ratioBarJp.style.width = '50%';
  }

  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = actx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(actx.destination);

  const library = new Map();

  let availablePhonemes = new Set();

  let cmudict = null;

  let libraryReady = false;
  let dictReady = false;
  let jpLoaded = false;
  let jpLoadingPromise = null;

  function updateReadyStatus() {
    if (!libraryReady || !dictReady) return;
    els.loadStatus.textContent = `ready. ${availablePhonemes.size} phonemes loaded`;
  }

  const waveCanvas = document.getElementById('waveCanvas');
  const waveCtx = waveCanvas.getContext('2d');
  const waveData = new Uint8Array(analyser.fftSize);
  let ambientPhase = 0;

  function resizeCanvas() {
    waveCanvas.width = window.innerWidth;
    waveCanvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function renderBackgroundSoundwave() {
    requestAnimationFrame(renderBackgroundSoundwave);

    const w = waveCanvas.width;
    const h = waveCanvas.height;
    const centerY = h / 2;

    waveCtx.clearRect(0, 0, w, h);

    analyser.getByteTimeDomainData(waveData);

    let hasAudio = false;
    for (let i = 0; i < waveData.length; i++) {
      if (Math.abs(waveData[i] - 128) > 2) {
        hasAudio = true;
        break;
      }
    }

    waveCtx.lineWidth = 2;
    waveCtx.strokeStyle = '#ffd700';
    waveCtx.shadowColor = '#ffd700';
    waveCtx.shadowBlur = 8;
    waveCtx.beginPath();

    const sliceWidth = w / waveData.length;
    let x = 0;
    ambientPhase += 0.035;

    for (let i = 0; i < waveData.length; i++) {
      let amp = (waveData[i] - 128) / 128.0;

      if (!hasAudio) {

        const normX = (i / waveData.length) * Math.PI * 4;
        amp = Math.sin(normX + ambientPhase) * 0.04 + Math.sin(normX * 2.2 - ambientPhase * 0.6) * 0.025;
      }

      const y = centerY + amp * (h * 0.28);

      if (i === 0) {
        waveCtx.moveTo(x, y);
      } else {
        waveCtx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    waveCtx.lineTo(w, centerY);
    waveCtx.stroke();
  }

  renderBackgroundSoundwave();

  function analyzeClip(buffer) {
    const data = buffer.getChannelData(0);
    const n = data.length;
    if (n === 0) return { trimStart: 0, trimEnd: 0, rms: 0 };

    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    if (peak < 1e-6) return { trimStart: 0, trimEnd: n, rms: 0 };

    const floor = peak * 0.04;
    let start = 0;
    while (start < n && Math.abs(data[start]) < floor) start++;
    let end = n - 1;
    while (end > start && Math.abs(data[end]) < floor) end--;
    end++;

    let bestStart = start;
    let minStartDist = Infinity;
    for (let i = Math.max(1, start - 100); i <= Math.min(n - 1, start + 100); i++) {
      if (data[i] * data[i - 1] <= 0) {
        const dist = Math.abs(i - start);
        if (dist < minStartDist) {
          minStartDist = dist;
          bestStart = i;
        }
      }
    }
    if (minStartDist !== Infinity) start = bestStart;

    let bestEnd = end;
    let minEndDist = Infinity;
    for (let i = Math.max(start + 2, end - 100); i <= Math.min(n - 1, end + 100); i++) {
      if (data[i] * data[i - 1] <= 0) {
        const dist = Math.abs(i - end);
        if (dist < minEndDist) {
          minEndDist = dist;
          bestEnd = i;
        }
      }
    }
    if (minEndDist !== Infinity) end = bestEnd;

    if (end - start < Math.min(n, Math.round(buffer.sampleRate * 0.004))) {
      start = 0;
      end = n;
    }

    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += data[i] * data[i];
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));

    return { trimStart: start, trimEnd: end, rms };
  }

  const mainThreadYield = () => new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });

  function createAnalysisScheduler(batchSize) {
    let countSinceYield = 0;

    return async function scheduleAnalysis(buf) {
      const trim = analyzeClip(buf);
      countSinceYield++;
      if (countSinceYield >= batchSize) {
        countSinceYield = 0;
        await mainThreadYield();
      }
      return trim;
    };
  }

  async function loadLibrarySpec(spec, progressCallback) {
    let res;
    try {
      res = await fetch(spec.manifestUrl);
      if (!res.ok) {
        console.warn(`Manifest not found at ${spec.manifestUrl} (${res.status})`);
        return false;
      }
    } catch (e) {
      console.warn(`Failed to load manifest from ${spec.manifestUrl}:`, e);
      return false;
    }

    const manifest = await res.json();
    const phonemeKeys = Object.keys(manifest.phonemes || {});
    let totalClips = 0;
    phonemeKeys.forEach(k => {
      totalClips += (manifest.phonemes[k].clips || []).length;
    });

    let loaded = 0;
    if (progressCallback) progressCallback(loaded, totalClips);

    const tasks = [];
    const scheduleAnalysis = createAnalysisScheduler(8);

    phonemeKeys.forEach(manifestKey => {

      let targetKeys;
      if (spec.origin === 'jp') {
        targetKeys = mapJpKeyToArpabet(manifestKey);
        if (!targetKeys) {
          console.warn(`No ARPAbet mapping for JP phoneme "${manifestKey}"; clips will be unreachable.`);
          targetKeys = [manifestKey];
        }
      } else {
        targetKeys = [manifestKey];
      }

      const buckets = targetKeys.map(key => {
        if (!library.has(key)) {
          library.set(key, {
            buffers: [],
            durations_ms: [],
            sources: [],
            trims: [],
            origins: [],
            files: [],
            pool: [],
            medianDuration: 100
          });
        }
        return library.get(key);
      });

      const entry = manifest.phonemes[manifestKey];
      const clips = entry.clips || [];

      clips.forEach(clip => {
        const url = spec.root + clip.file;

        const slotIndices = buckets.map(bucket => {
          const idx = bucket.buffers.length;
          bucket.buffers.push(null);
          bucket.durations_ms.push(clip.duration_ms || 100);
          bucket.sources.push(clip.source || '');
          bucket.trims.push(null);
          bucket.origins.push(spec.origin);
          bucket.files.push(clip.file);
          return idx;
        });

        const task = fetch(url)
          .then(r => {
            if (!r.ok) throw new Error('missing clip ' + clip.file);
            return r.arrayBuffer();
          })
          .then(ab => new Promise((resolve, reject) => {
            const maybePromise = actx.decodeAudioData(ab, resolve, reject);
            if (maybePromise && typeof maybePromise.then === 'function') {
              maybePromise.then(resolve, reject);
            }
          }))
          .then(async buf => {
            const trim = await scheduleAnalysis(buf);
            buckets.forEach((bucket, bi) => {
              const idx = slotIndices[bi];
              bucket.buffers[idx] = buf;
              bucket.trims[idx] = trim;
            });
          })
          .catch(err => {
            console.warn(`clip failed to decode (${spec.origin}):`, clip.file, err);
          })
          .finally(() => {
            loaded++;
            if (progressCallback) progressCallback(loaded, totalClips);
          });
        tasks.push(task);
      });
    });

    await Promise.all(tasks);
    return true;
  }

  async function ensureJpLibraryLoaded() {
    if (jpLoaded) return;
    if (jpLoadingPromise) return jpLoadingPromise;

    jpLoadingPromise = (async () => {
      const spec = { root: LIBRARY_ROOT_JP, manifestUrl: MANIFEST_URL_JP, origin: 'jp' };
      await loadLibrarySpec(spec, (loaded, total) => {
        els.loadStatus.textContent = `loading Japanese phonemes... ${loaded}/${total}`;
      });
      jpLoaded = true;
    })();

    await jpLoadingPromise;
  }

  async function loadDict() {
    const res = await fetch(CMUDICT_URL);
    if (!res.ok) throw new Error('cmudict_full.json not found (' + res.status + ')');
    cmudict = await res.json();
    dictReady = true;
  }

  const G2P_RULES = [
    [/^ing/, ['IH0', 'NG'], 3],
    [/^tion/, ['SH', 'AH0', 'N'], 4],
    [/^sion/, ['ZH', 'AH0', 'N'], 4],
    [/^ough/, ['AH1', 'F'], 4],
    [/^augh/, ['AE1', 'F'], 4],
    [/^eigh/, ['EY1'], 4],
    [/^ture/, ['CH', 'ER0'], 4],
    [/^ous/, ['AH0', 'S'], 3],
    [/^dge/, ['JH'], 3],
    [/^tch/, ['CH'], 3],
    [/^igh/, ['AY1'], 3],
    [/^sch/, ['SH'], 3],
    [/^the/, ['DH', 'AH0'], 3],
    [/^er/, ['ER0'], 2],
    [/^ly/, ['L', 'IY0'], 2],
    [/^le/, ['L'], 2],
    [/^ed/, ['D'], 2],
    [/^es/, ['IH0', 'Z'], 2],
    [/^ck/, ['K'], 2],
    [/^ph/, ['F'], 2],
    [/^th/, ['TH'], 2],
    [/^sh/, ['SH'], 2],
    [/^ch/, ['CH'], 2],
    [/^wh/, ['W'], 2],
    [/^ng/, ['NG'], 2],
    [/^qu/, ['K', 'W'], 2],
    [/^gh/, ['G'], 2],
    [/^kn/, ['N'], 2],
    [/^wr/, ['R'], 2],
    [/^ee/, ['IY1'], 2],
    [/^ea/, ['IY1'], 2],
    [/^ai/, ['EY1'], 2],
    [/^ay/, ['EY1'], 2],
    [/^oa/, ['OW1'], 2],
    [/^oo/, ['UW1'], 2],
    [/^ou/, ['AW1'], 2],
    [/^ow/, ['AW1'], 2],
    [/^oi/, ['OY1'], 2],
    [/^oy/, ['OY1'], 2],
    [/^au/, ['AO1'], 2],
    [/^aw/, ['AO1'], 2],
    [/^ie/, ['IY1'], 2],
    [/^ue/, ['UW1'], 2],
    [/^a/, ['AE1'], 1],
    [/^e/, ['EH1'], 1],
    [/^i/, ['IH1'], 1],
    [/^o/, ['AA1'], 1],
    [/^u/, ['AH1'], 1],
    [/^y/, ['IH1'], 1],
    [/^b/, ['B'], 1],
    [/^c/, ['K'], 1],
    [/^d/, ['D'], 1],
    [/^f/, ['F'], 1],
    [/^g/, ['G'], 1],
    [/^h/, ['HH'], 1],
    [/^j/, ['JH'], 1],
    [/^k/, ['K'], 1],
    [/^l/, ['L'], 1],
    [/^m/, ['M'], 1],
    [/^n/, ['N'], 1],
    [/^p/, ['P'], 1],
    [/^r/, ['R'], 1],
    [/^s/, ['S'], 1],
    [/^t/, ['T'], 1],
    [/^v/, ['V'], 1],
    [/^w/, ['W'], 1],
    [/^x/, ['K', 'S'], 1],
    [/^z/, ['Z'], 1],
  ];

  function ruleBasedG2P(word) {
    const w = word.toLowerCase().replace(/[^a-z']/g, '');
    if (!w) return [];
    let i = 0;
    const out = [];
    while (i < w.length) {
      const rest = w.slice(i);
      let matched = false;
      for (const [re, phones, len] of G2P_RULES) {
        if (re.test(rest)) {
          if (rest === 'e' && out.length > 0) { i += 1; matched = true; break; }
          out.push(...phones);
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) i += 1;
    }
    if (!out.some(p => /[12]$/.test(p))) {
      for (let k = 0; k < out.length; k++) {
        if (/^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)0?$/.test(out[k])) {
          out[k] = out[k].replace(/0?$/, '1');
          break;
        }
      }
    }
    return out;
  }

  function wordToPhones(rawWord) {
    const key = rawWord.toLowerCase();
    if (cmudict && Object.prototype.hasOwnProperty.call(cmudict, key)) {
      return { phones: cmudict[key], oov: false };
    }
    const stripped = key.replace(/['’]s$/, '');
    if (stripped !== key && cmudict && Object.prototype.hasOwnProperty.call(cmudict, stripped)) {
      return { phones: [...cmudict[stripped], 'S'], oov: false };
    }
    return { phones: ruleBasedG2P(key), oov: true };
  }

  const SUBSTITUTE = {
    ZH: ['SH', 'Z'],
    AXR: ['ER1', 'ER0'],
    AX: ['AH0', 'AH1'],
  };

  const JP_IPA_TO_ARPABET_VOWEL = {

    'a': 'AA', 'aː': 'AA',
    'e': 'EH', 'eː': 'EH',
    'i': 'IY', 'iː': 'IY', 'i̥': 'IY',
    'o': 'OW', 'oː': 'OW',
    'ɯ': 'UW', 'ɯː': 'UW', 'ɯ̥': 'UW',
    'ɨ': 'IH', 'ɨː': 'IH', 'ɨ̥': 'IH',
  };
  const JP_IPA_TO_ARPABET_CONSONANT = {

    'j': 'Y',
    'w': 'W',

    'p': 'P', 'pʲ': 'P',
    'b': 'B',
    't': 'T', 'tʲ': 'T', 'tː': 'T',
    'd': 'D', 'dʲ': 'D', 'dː': 'D',
    'k': 'K',
    'ɡ': 'G',

    'ts': 'CH', 'tsː': 'CH',
    'tɕ': 'CH', 'tɕː': 'CH',
    'dʑ': 'JH',

    's': 'S',
    'z': 'Z',
    'ɕ': 'SH',
    'ʑ': 'ZH',
    'h': 'HH',
    'ç': 'HH',
    'ɸ': 'F',
    'c': 'K',

    'm': 'M', 'mʲ': 'M',
    'n': 'N',
    'ɲ': 'N',
    'ŋ': 'NG',
    'ɴ': 'NG',

    'ɾ': 'R', 'ɾʲ': 'R',

    'ɡʲ': 'G',
  };

  function mapJpKeyToArpabet(ipaKey) {
    const vowelBase = JP_IPA_TO_ARPABET_VOWEL[ipaKey];
    if (vowelBase) return [vowelBase + '0', vowelBase + '1', vowelBase + '2'];
    const consonant = JP_IPA_TO_ARPABET_CONSONANT[ipaKey];
    if (consonant) return [consonant];
    return null;
  }

  const WORD_CLIP_HINTS = {
    water: {
      W: 'snd_flowery_voiceclip_with_your_powers_combined',
    },
  };

  const SAME_SOURCE_BONUS = 4.5;
  const SOURCE_COVERAGE_BONUS = 1.5;
  const CLIP_HINT_BONUS = 3.0;

  const JP_PREFERENCE_BONUS = 1.2;
  const JP_CONTINUITY_BONUS = 0.8;

  const VOWEL_BASES = new Set([
    'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER',
    'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
  ]);
  const SONORANT_BASES = new Set(['L', 'R', 'M', 'N', 'NG', 'W', 'Y']);

  const STRONG_VOWEL_SOURCE_OUTLIER = /(?:^|_)(?:hah|huh|heh|gasp|sigh|laugh|mysterious_wind|powering_up)(?:_|$)/;
  const STRONG_SONORANT_SOURCE_OUTLIER = /(?:^|_)(?:mysterious_wind|wow)(?:_|$)/;
  const SOURCE_CONTEXT_PENALTIES = [
    { pattern: /(?:^|_)forthefans(?:_|$)/, penalty: 2.75 },
  ];

  function phonemeBase(phoneKey) {
    return phoneKey.replace(/[0-2]$/, '');
  }

  function isVowelPhone(phoneKey) {
    return VOWEL_BASES.has(phonemeBase(phoneKey));
  }

  function getSourceQualityPenalty(phoneKey, sourceName) {
    const base = phonemeBase(phoneKey);
    if ((!isVowelPhone(phoneKey) && !SONORANT_BASES.has(base)) || !sourceName) return 0;
    const source = sourceName.toLowerCase();
    let penalty = 0;
    if (STRONG_VOWEL_SOURCE_OUTLIER.test(source)) penalty += 8.0;
    if (SONORANT_BASES.has(base)) {
      if (STRONG_SONORANT_SOURCE_OUTLIER.test(source)) penalty += 8.0;
    }
    SOURCE_CONTEXT_PENALTIES.forEach((rule) => {
      if (rule.pattern.test(source)) penalty += rule.penalty;
    });
    return penalty;
  }

  function isStrongVowelSourceOutlier(phoneKey, sourceName) {
    return isVowelPhone(phoneKey)
      && STRONG_VOWEL_SOURCE_OUTLIER.test((sourceName || '').toLowerCase());
  }

  function isStrongSourceOutlier(phoneKey, sourceName) {
    const source = (sourceName || '').toLowerCase();
    const base = phonemeBase(phoneKey);
    return isStrongVowelSourceOutlier(phoneKey, source)
      || (SONORANT_BASES.has(base) && STRONG_SONORANT_SOURCE_OUTLIER.test(source));
  }

  function sourceWords(sourceName) {
    const words = (sourceName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const marker = words.indexOf('voiceclip');
    return marker >= 0 ? words.slice(marker + 1) : words;
  }

  function sourceHasExactWord(sourceName, targetWord) {
    const target = (targetWord || '').toLowerCase();
    if (!target) return false;
    return sourceWords(sourceName).some((word) => {
      if (word === target) return true;
      return word.startsWith(target) && /^\d+$/.test(word.slice(target.length));
    });
  }

  function getSourceWordMismatchPenalty(sourceName, targetWord) {
    const target = (targetWord || '').toLowerCase();
    if (!target || sourceHasExactWord(sourceName, target)) return 0;

    const hasNearWord = sourceWords(sourceName).some((word) => (
      word.includes(target) && word.length - target.length <= 6
    ));
    return hasNearWord ? 4.0 : 0;
  }

  function resolvePhoneme(phone) {
    if (availablePhonemes.has(phone)) return phone;

    const m = phone.match(/^([A-Z]+)([0-2])$/);
    if (m) {
      const base = m[1];
      for (const stress of ['1', '0', '2']) {
        const candidate = base + stress;
        if (availablePhonemes.has(candidate)) return candidate;
      }
    } else if (availablePhonemes.has(phone)) {
      return phone;
    }

    if (SUBSTITUTE[phone]) {
      for (const sub of SUBSTITUTE[phone]) {
        const resolved = resolvePhoneme(sub);
        if (resolved) return resolved;
      }
    }

    return null;
  }

  function tokenize(text) {
    const tokens = [];
    const re = /[A-Za-z0-9'’]+|[.!?,;:]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    return tokens;
  }

  function buildCandidatePools() {
    const activePhonemesSet = new Set();

    library.forEach((bucket, key) => {
      const n = bucket.buffers.length;
      if (n === 0) { bucket.pool = []; return; }

      const validIndices = [];
      for (let i = 0; i < n; i++) {
        if (!bucket.buffers[i]) continue;
        const origin = bucket.origins[i];
        if (!useJpVoicelines && origin === 'jp') continue;
        validIndices.push(i);
      }

      if (validIndices.length === 0) {
        bucket.pool = [];
        return;
      }

      activePhonemesSet.add(key);

      const validDurs = validIndices.map(i => bucket.durations_ms[i]).sort((a, b) => a - b);
      bucket.medianDuration = validDurs[Math.floor(validDurs.length / 2)] || 100;

      const scored = [];
      for (const i of validIndices) {
        const buf = bucket.buffers[i];
        const dur = bucket.durations_ms[i] || bucket.medianDuration;
        const ratio = dur / (bucket.medianDuration || 100);
        const durationScore = 1 / (1 + Math.abs(Math.log(Math.max(ratio, 0.01))));
        const trim = bucket.trims[i];
        const trimFrames = trim ? Math.max(0, trim.trimEnd - trim.trimStart) : buf.length;
        const trimRatio = trimFrames / Math.max(1, buf.length);
        const outlierPenalty = ratio > 1.45 ? (ratio - 1.45) * 1.25 : 0;
        const sourcePenalty = getSourceQualityPenalty(key, bucket.sources[i]);

        const isJpClip = (useJpVoicelines && bucket.origins[i] === 'jp');

        const jpBonus = isJpClip ? JP_PREFERENCE_BONUS : 0;

        const score = durationScore * 0.7 + Math.min(1, trimRatio) * 0.3
          - outlierPenalty - sourcePenalty + jpBonus;
        scored.push({ i, score });
      }

      scored.sort((a, b) => b.score - a.score);
      const keep = Math.max(3, Math.ceil(scored.length * 0.7));
      const qualityPool = scored.length
        ? scored.slice(0, keep).map((s) => s.i)
        : validIndices;
      const cleanPool = qualityPool.filter((i) => !isStrongSourceOutlier(key, bucket.sources[i]));
      bucket.pool = cleanPool.length ? cleanPool : qualityPool;
    });

    availablePhonemes = activePhonemesSet;
  }

  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  function getTargetRMS(phoneKey) {
    const base = phoneKey.replace(/[0-2]$/, '');
    if (/^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)$/.test(base)) return 0.12;
    if (/^(L|R|M|N|NG|W|Y)$/.test(base)) return 0.10;
    if (/^(S|SH|F|TH|Z|ZH|CH|JH|HH|V|DH)$/.test(base)) return 0.08;
    if (/^(P|T|K|B|D|G)$/.test(base)) return 0.09;
    return 0.10;
  }

  function getPhonemeOverlapSec(phoneKey1, phoneKey2) {
    const base1 = phoneKey1.replace(/[0-2]$/, '');
    const base2 = phoneKey2.replace(/[0-2]$/, '');

    const isPlosive1 = /^(P|T|K|B|D|G)$/.test(base1);
    const isPlosive2 = /^(P|T|K|B|D|G)$/.test(base2);
    if (isPlosive1 || isPlosive2) return 0.005;

    const isVowel1 = /^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)$/.test(base1);
    const isVowel2 = /^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)$/.test(base2);
    if (isVowel1 && isVowel2) return 0.025;

    const isLiquidOrGlide1 = /^(L|R|W|Y)$/.test(base1);
    const isLiquidOrGlide2 = /^(L|R|W|Y)$/.test(base2);
    if (isLiquidOrGlide1 || isLiquidOrGlide2) return 0.012;

    return 0.016;
  }

  function selectWordClips(targetWord, resolvedPhones, sentenceSeed, phonemePositionOffset) {
    const m = resolvedPhones.length;
    if (m === 0) return [];

    const cleanTargetWord = (targetWord || '').toLowerCase().replace(/[^a-z]/g, '');
    const clipHints = WORD_CLIP_HINTS[cleanTargetWord] || null;

    const sourceCoverage = new Map();
    for (let j = 0; j < m; j++) {
      const key = resolvedPhones[j];
      const bucket = library.get(key);
      if (!bucket) continue;
      bucket.sources.forEach((src) => {
        if (!src) return;
        sourceCoverage.set(src, (sourceCoverage.get(src) || 0) + 1);
      });
    }

    function sourceCanBePreferred(phoneKey, sourceName) {
      return getSourceQualityPenalty(phoneKey, sourceName) === 0;
    }

    function sourceIsNativeTargetRecording(sourceName) {
      return cleanTargetWord.length >= 3 && sourceHasExactWord(sourceName, cleanTargetWord);
    }

    function sourceIsCleanForContinuity(phoneKey, sourceName) {
      return !isStrongSourceOutlier(phoneKey, sourceName);
    }

    function keepOnlyCleanSourceCandidates(key, bucket, pool) {
      const cleanPool = pool.filter((idx) => !isStrongSourceOutlier(key, bucket.sources[idx]));
      return cleanPool.length ? cleanPool : pool;
    }

    function keepOnlyWordRelevantCandidates(bucket, pool) {

      const relevantPool = pool.filter((idx) => (
        bucket.origins[idx] === 'jp'
        || getSourceWordMismatchPenalty(bucket.sources[idx], cleanTargetWord) === 0
      ));
      return relevantPool.length ? relevantPool : pool;
    }

    const candidates = [];
    for (let j = 0; j < m; j++) {
      const key = resolvedPhones[j];
      const bucket = library.get(key);
      if (!bucket || bucket.buffers.length === 0) return null;
      let pool = (bucket.pool && bucket.pool.length) ? bucket.pool : bucket.buffers.map((_, i) => i);

      if (!useJpVoicelines) {
        pool = pool.filter(idx => bucket.origins[idx] !== 'jp');
      }

      if (pool.length === 0) {
        pool = bucket.buffers
          .map((b, i) => b && (useJpVoicelines || bucket.origins[i] !== 'jp') ? i : -1)
          .filter(i => i >= 0);
      }

      if (pool.length === 0) return null;

      pool = keepOnlyCleanSourceCandidates(key, bucket, pool);
      pool = keepOnlyWordRelevantCandidates(bucket, pool);
      if (clipHints && clipHints[key]) {
        const hinted = pool.filter((idx) => bucket.sources[idx] === clipHints[key]);
        const unhinted = pool.filter((idx) => bucket.sources[idx] !== clipHints[key]);
        pool = hinted.concat(unhinted);
      }
      candidates.push({ key, bucket, pool });
    }

    const dp = [];
    const back = [];

    dp[0] = [];
    back[0] = [];
    const pool0 = candidates[0].pool;
    const key0 = candidates[0].key;
    const bucket0 = candidates[0].bucket;

    for (let c = 0; c < pool0.length; c++) {
      const clipIdx = pool0[c];
      const trim = bucket0.trims[clipIdx];
      const srcName = bucket0.sources ? (bucket0.sources[clipIdx] || '').toLowerCase() : '';
      const hashVal = hashString(`${sentenceSeed}::${key0}::${phonemePositionOffset}::${c}`);
      const tieBreaker = (hashVal % 100) * 0.001;

      const dur = bucket0.durations_ms[clipIdx] || 100;
      const ratio = dur / (bucket0.medianDuration || 100);
      const durationScore = 1 / (1 + Math.abs(Math.log(Math.max(ratio, 0.01))));
      let targetCost = (1.0 - durationScore) * 1.5
        - (trim ? Math.min(0.5, trim.rms * 2.5) : 0.2)
        + getSourceQualityPenalty(key0, bucket0.sources[clipIdx])
        + getSourceWordMismatchPenalty(bucket0.sources[clipIdx], cleanTargetWord)
        + tieBreaker;
      if (ratio > 1.45) targetCost += (ratio - 1.45) * 1.5;
      if (ratio < 0.6) targetCost += (0.6 - ratio) * 2.5;

      if (useJpVoicelines && bucket0.origins[clipIdx] === 'jp') {
        targetCost -= JP_PREFERENCE_BONUS;
      }

      const coverage = sourceCoverage.get(bucket0.sources[clipIdx]) || 0;
      if (coverage > 1
        && sourceCanBePreferred(key0, bucket0.sources[clipIdx])
        && sourceIsNativeTargetRecording(bucket0.sources[clipIdx])) {
        targetCost -= SOURCE_COVERAGE_BONUS * (coverage - 1);
      }
      if (clipHints && clipHints[key0] && bucket0.sources[clipIdx] === clipHints[key0]
        && sourceCanBePreferred(key0, bucket0.sources[clipIdx])) {
        targetCost -= CLIP_HINT_BONUS;
      }

      if (cleanTargetWord.length >= 3 && sourceHasExactWord(srcName, cleanTargetWord)) {
        targetCost -= 3.5;
      }

      dp[0][c] = targetCost;
      back[0][c] = -1;
    }

    for (let j = 1; j < m; j++) {
      dp[j] = [];
      back[j] = [];
      const poolCurr = candidates[j].pool;
      const keyCurr = candidates[j].key;
      const bucketCurr = candidates[j].bucket;
      const poolPrev = candidates[j - 1].pool;
      const bucketPrev = candidates[j - 1].bucket;

      for (let cCurr = 0; cCurr < poolCurr.length; cCurr++) {
        const idxCurr = poolCurr[cCurr];
        const trimCurr = bucketCurr.trims[idxCurr];
        const bufCurr = bucketCurr.buffers[idxCurr];
        const srcCurr = bucketCurr.sources ? (bucketCurr.sources[idxCurr] || '').toLowerCase() : '';
        const rmsCurr = trimCurr ? trimCurr.rms : 0.1;
        const firstSample = (bufCurr && trimCurr && trimCurr.trimStart < bufCurr.length) ? bufCurr.getChannelData(0)[trimCurr.trimStart] : 0;

        const secondSample = (bufCurr && trimCurr && trimCurr.trimStart + 1 < bufCurr.length) ? bufCurr.getChannelData(0)[trimCurr.trimStart + 1] : firstSample;
        const slopeCurr = secondSample - firstSample;

        const durCurr = bucketCurr.durations_ms[idxCurr] || 100;
        const ratioCurr = durCurr / (bucketCurr.medianDuration || 100);
        const durationScoreCurr = 1 / (1 + Math.abs(Math.log(Math.max(ratioCurr, 0.01))));
        let targetCost = (1.0 - durationScoreCurr) * 1.5
          + getSourceQualityPenalty(keyCurr, bucketCurr.sources[idxCurr]);
        if (ratioCurr > 1.45) targetCost += (ratioCurr - 1.45) * 1.5;
        if (ratioCurr < 0.6) targetCost += (0.6 - ratioCurr) * 2.5;

        if (useJpVoicelines && bucketCurr.origins[idxCurr] === 'jp') {
          targetCost -= JP_PREFERENCE_BONUS;
        }

        const coverageCurr = sourceCoverage.get(bucketCurr.sources[idxCurr]) || 0;
        if (coverageCurr > 1
          && sourceCanBePreferred(keyCurr, bucketCurr.sources[idxCurr])
          && sourceIsNativeTargetRecording(bucketCurr.sources[idxCurr])) {
          targetCost -= SOURCE_COVERAGE_BONUS * (coverageCurr - 1);
        }
        if (clipHints && clipHints[keyCurr] && bucketCurr.sources[idxCurr] === clipHints[keyCurr]
          && sourceCanBePreferred(keyCurr, bucketCurr.sources[idxCurr])) {
          targetCost -= CLIP_HINT_BONUS;
        }

        const wordSourcePenalty = getSourceWordMismatchPenalty(srcCurr, cleanTargetWord);
        targetCost += wordSourcePenalty;

        const isTargetMatchCurr = cleanTargetWord.length >= 3
          && sourceHasExactWord(srcCurr, cleanTargetWord);
        if (isTargetMatchCurr) {
          targetCost -= 3.5;
        }

        let minCost = Infinity;
        let bestPrevIdx = 0;

        for (let cPrev = 0; cPrev < poolPrev.length; cPrev++) {
          const idxPrev = poolPrev[cPrev];
          const trimPrev = bucketPrev.trims[idxPrev];
          const bufPrev = bucketPrev.buffers[idxPrev];
          const srcPrev = bucketPrev.sources ? (bucketPrev.sources[idxPrev] || '').toLowerCase() : '';
          const rmsPrev = trimPrev ? trimPrev.rms : 0.1;

          const lastSample = (bufPrev && trimPrev && trimPrev.trimEnd > 0) ? bufPrev.getChannelData(0)[trimPrev.trimEnd - 1] : 0;
          const secondToLastSample = (bufPrev && trimPrev && trimPrev.trimEnd > 2) ? bufPrev.getChannelData(0)[trimPrev.trimEnd - 2] : lastSample;
          const slopePrev = lastSample - secondToLastSample;

          const rmsDiff = Math.abs(rmsCurr - rmsPrev);
          const sampleDiff = Math.abs(lastSample - firstSample);
          const slopeDiff = Math.abs(slopeCurr - slopePrev);

          let joinCost = rmsDiff * 2.5 + sampleDiff * 2.0 + slopeDiff * 5.0;

          if (srcPrev && srcCurr && srcPrev === srcCurr
            && sourceIsCleanForContinuity(keyCurr, srcCurr)
            && sourceIsCleanForContinuity(candidates[j - 1].key, srcPrev)
            && sourceIsNativeTargetRecording(srcCurr)
            && sourceIsNativeTargetRecording(srcPrev)) {
            joinCost -= SAME_SOURCE_BONUS;
          }

          if (useJpVoicelines && bucketPrev.origins[idxPrev] === 'jp' && bucketCurr.origins[idxCurr] === 'jp') {
            joinCost -= JP_CONTINUITY_BONUS;
          }

          const cost = dp[j - 1][cPrev] + targetCost + joinCost;
          if (cost < minCost) {
            minCost = cost;
            bestPrevIdx = cPrev;
          }
        }

        const hashVal = hashString(`${sentenceSeed}::${keyCurr}::${phonemePositionOffset + j}::${cCurr}`);
        const tieBreaker = (hashVal % 100) * 0.001;
        dp[j][cCurr] = minCost + tieBreaker;
        back[j][cCurr] = bestPrevIdx;
      }
    }

    let bestLastCand = 0;
    let minFinalCost = Infinity;
    for (let c = 0; c < candidates[m - 1].pool.length; c++) {
      if (dp[m - 1][c] < minFinalCost) {
        minFinalCost = dp[m - 1][c];
        bestLastCand = c;
      }
    }

    const resultClipIndices = new Array(m);
    let currCand = bestLastCand;
    for (let j = m - 1; j >= 0; j--) {
      resultClipIndices[j] = candidates[j].pool[currCand];
      currCand = back[j][currCand];
    }

    return resultClipIndices;
  }

  function buildPlan(text) {
    const tokens = tokenize(text);
    const plan = [];
    const wordMeta = [];
    let hadOov = false;
    let anyResolved = false;
    let phonemePosition = 0;

    tokens.forEach((tok, ti) => {
      if (/^[.!?,;:]$/.test(tok.text)) {
        const pause = PAUSE_PUNCT[tok.text] || 0.15;
        plan.push({ kind: 'silence', duration: pause });
        return;
      }

      const { phones, oov } = wordToPhones(tok.text);
      if (oov) hadOov = true;

      const wordIndex = wordMeta.length;
      const resolvedPhones = [];
      phones.forEach((p) => {
        const resolved = resolvePhoneme(p);
        if (resolved) resolvedPhones.push(resolved);
      });

      const wordClipIndices = selectWordClips(tok.text, resolvedPhones, text, phonemePosition);
      phonemePosition += resolvedPhones.length;

      wordMeta.push({ start: tok.start, end: tok.end, phoneCount: resolvedPhones.length, planStart: plan.length });

      if (wordClipIndices && wordClipIndices.length === resolvedPhones.length) {
        const m = resolvedPhones.length;
        for (let pi = 0; pi < m; pi++) {
          const key = resolvedPhones[pi];
          const bucket = library.get(key);
          const clipIdx = wordClipIndices[pi];
          const buf = bucket ? bucket.buffers[clipIdx] : null;
          const trim = bucket ? bucket.trims[clipIdx] : null;
          const origin = bucket ? bucket.origins[clipIdx] : 'en';
          const file = bucket ? bucket.files[clipIdx] : key;

          if (!buf || !trim) continue;

          anyResolved = true;
          const trimmedDuration = Math.max(0.005, (trim.trimEnd - trim.trimStart) / buf.sampleRate);
          const targetRMS = getTargetRMS(key);
          const clipRMS = trim.rms;
          const gainScale = clipRMS > 1e-4 ? Math.min(2.2, Math.max(0.35, targetRMS / clipRMS)) : 1.0;

          let overlapPrev = 0;
          if (pi > 0) {
            const prevKey = resolvedPhones[pi - 1];
            const maxOverlap = Math.min(trimmedDuration * 0.40, 0.03);
            overlapPrev = Math.min(maxOverlap, getPhonemeOverlapSec(prevKey, key));
          }

          plan.push({
            kind: 'clip',
            wordIndex,
            phoneIndexInWord: pi,
            phoneKey: key,
            buffer: buf,
            trimStart: trim.trimStart,
            trimEnd: trim.trimEnd,
            trimmedDuration,
            gainScale,
            overlapPrev,
            origin,
            file
          });
        }
      }

      const next = tokens[ti + 1];
      if (!next || !/^[.!?,;:]$/.test(next.text)) {
        plan.push({ kind: 'silence', duration: WORD_GAP });
      }
    });

    return { plan, wordMeta, tokens, hadOov, anyResolved };
  }

  async function renderPlan(built) {
    const { plan, wordMeta, tokens } = built;

    let totalDuration = 0;
    let enAudioDuration = 0;
    let jpAudioDuration = 0;

    const timedPlan = plan.map((item, idx) => {
      if (item.kind === 'silence') {
        const start = totalDuration;
        totalDuration += item.duration;
        return { ...item, start, duration: item.duration };
      }

      let start = totalDuration;
      let duration = item.trimmedDuration;

      if (item.overlapPrev > 0) {
        start = totalDuration - item.overlapPrev;
        const effectiveLength = item.trimmedDuration - item.overlapPrev;
        totalDuration += effectiveLength;
        duration = effectiveLength;
      } else {
        totalDuration += item.trimmedDuration;
      }

      if (item.origin === 'jp') {
        jpAudioDuration += duration;
      } else {
        enAudioDuration += duration;
      }

      return { ...item, start, duration: item.trimmedDuration };
    });

    if (totalDuration <= 0) totalDuration = 0.05;

    const sampleRate = actx.sampleRate;
    const SAFETY_PAD_SECONDS = 0.15;
    const totalFrames = Math.ceil((totalDuration + SAFETY_PAD_SECONDS) * sampleRate);
    const offline = new OfflineAudioContext(1, totalFrames, sampleRate);

    const highPass = offline.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 70;

    const lowShelf = offline.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 180;
    lowShelf.gain.value = 1.5;

    const presence = offline.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 1500;
    presence.Q.value = 1.2;
    presence.gain.value = 2.0;

    const compressor = offline.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 10;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.1;

    highPass.connect(lowShelf);
    lowShelf.connect(presence);
    presence.connect(compressor);
    compressor.connect(offline.destination);

    timedPlan.forEach((item, idx) => {
      if (item.kind !== 'clip') return;

      const rawData = item.buffer.getChannelData(0);
      const startFrame = item.trimStart;
      const endFrame = item.trimEnd;
      const numFrames = Math.max(1, endFrame - startFrame);

      const clipBuf = offline.createBuffer(1, numFrames, sampleRate);
      const clipData = clipBuf.getChannelData(0);

      const nextItem = timedPlan[idx + 1];
      const hasNextOverlap = (nextItem && nextItem.kind === 'clip' && nextItem.wordIndex === item.wordIndex && nextItem.overlapPrev > 0);
      const overlapNext = hasNextOverlap ? nextItem.overlapPrev : 0;

      const fadeInSec = item.overlapPrev > 0 ? item.overlapPrev : 0.004;
      const fadeOutSec = overlapNext > 0 ? overlapNext : 0.004;

      const fadeInFrames = Math.min(Math.floor(numFrames / 2), Math.round(fadeInSec * sampleRate));
      const fadeOutFrames = Math.min(Math.floor(numFrames / 2), Math.round(fadeOutSec * sampleRate));

      for (let f = 0; f < numFrames; f++) {
        let val = rawData[startFrame + f] * item.gainScale;

        if (f < fadeInFrames && fadeInFrames > 0) {
          if (item.overlapPrev > 0) {
            val *= Math.sin((Math.PI / 2) * (f / fadeInFrames));
          } else {
            val *= (f / fadeInFrames);
          }
        }

        const framesFromEnd = numFrames - 1 - f;
        if (framesFromEnd < fadeOutFrames && fadeOutFrames > 0) {
          if (overlapNext > 0) {
            val *= Math.cos((Math.PI / 2) * (1 - framesFromEnd / fadeOutFrames));
          } else {
            val *= (framesFromEnd / fadeOutFrames);
          }
        }

        clipData[f] = val;
      }

      const src = offline.createBufferSource();
      src.buffer = clipBuf;
      src.connect(highPass);
      src.start(item.start);
    });

    const padded = await offline.startRendering();

    const exactFrames = Math.min(Math.ceil(totalDuration * sampleRate), padded.length);
    const rendered = actx.createBuffer(padded.numberOfChannels, Math.max(exactFrames, 1), sampleRate);
    for (let ch = 0; ch < padded.numberOfChannels; ch++) {
      const src = padded.getChannelData(ch);
      const dst = rendered.getChannelData(ch);
      dst.set(src.subarray(0, rendered.length));
    }

    const wordTimingList = wordMeta.map((w, wi) => {
      const clips = timedPlan.filter((it) => it.kind === 'clip' && it.wordIndex === wi);
      if (clips.length === 0) {
        return { start: null, end: null, charStarts: [] };
      }
      const wStart = clips[0].start;
      const last = clips[clips.length - 1];
      const wEnd = last.start + last.duration;

      const totalWordSpan = w.end - w.start;
      const totalPhoneDuration = clips.reduce((s, c) => s + c.duration, 0) || 1;
      let charCursor = w.start;
      const subRanges = clips.map((c) => {
        const share = (c.duration / totalPhoneDuration) * totalWordSpan;
        const cStart = charCursor;
        let cEnd = charCursor + share;
        if (cEnd > w.end) cEnd = w.end;
        charCursor = cEnd;
        return {
          start: c.start,
          end: c.start + c.duration,
          charStart: Math.round(cStart),
          charEnd: Math.round(cEnd),
          phoneKey: c.phoneKey,
          file: c.file,
          origin: c.origin
        };
      });
      if (subRanges.length) subRanges[subRanges.length - 1].charEnd = w.end;

      return { start: wStart, end: wEnd, subRanges };
    });

    const combinedVoiceDuration = enAudioDuration + jpAudioDuration;
    let enPct = 0;
    let jpPct = 0;
    if (combinedVoiceDuration > 0) {
      enPct = Math.round((enAudioDuration / combinedVoiceDuration) * 100);
      jpPct = 100 - enPct;
    }

    return {
      buffer: rendered,
      duration: totalDuration,
      wordTimingList,
      tokens,
      enPct,
      jpPct
    };
  }

  let currentRender = null;
  let currentSource = null;
  let playStartCtxTime = 0;
  let rafHandle = null;
  let allSpans = [];

  function renderHighlightMarkup(rawText, tokens, wordTimingList) {
    const segments = [];
    let cursor = 0;

    const wordTokenIdxs = [];
    tokens.forEach((tok, ti) => {
      if (!/^[.!?,;:]$/.test(tok.text)) wordTokenIdxs.push(ti);
    });

    wordTokenIdxs.forEach((ti, wi) => {
      const tok = tokens[ti];
      if (tok.start > cursor) {
        segments.push({ text: rawText.slice(cursor, tok.start), timed: false });
      }
      const timing = wordTimingList[wi];
      if (timing && timing.start !== null && timing.subRanges && timing.subRanges.length) {
        let localCursor = tok.start;
        timing.subRanges.forEach((sr) => {
          if (sr.charStart > localCursor) {
            segments.push({ text: rawText.slice(localCursor, sr.charStart), timed: false });
          }
          const segEnd = Math.max(sr.charEnd, sr.charStart);
          segments.push({
            text: rawText.slice(sr.charStart, segEnd),
            timed: true,
            start: sr.start,
            end: sr.end,
            phoneKey: sr.phoneKey,
            file: sr.file,
            origin: sr.origin
          });
          localCursor = segEnd;
        });
        if (localCursor < tok.end) {
          segments.push({ text: rawText.slice(localCursor, tok.end), timed: false, oov: true });
        }
      } else {
        segments.push({ text: rawText.slice(tok.start, tok.end), timed: false, oov: true });
      }
      cursor = tok.end;
    });

    if (cursor < rawText.length) {
      segments.push({ text: rawText.slice(cursor), timed: false });
    }

    els.editable.innerHTML = '';
    const spans = [];
    segments.forEach((seg) => {
      if (seg.text === '') return;
      if (!seg.timed) {
        const node = document.createTextNode(seg.text);
        els.editable.appendChild(node);
        return;
      }
      const span = document.createElement('span');
      span.className = 'tok pending';
      span.textContent = seg.text;
      els.editable.appendChild(span);
      spans.push({
        el: span,
        start: seg.start,
        end: seg.end,
        phoneKey: seg.phoneKey,
        file: seg.file,
        origin: seg.origin
      });
    });
    return spans;
  }

  function clearHighlightClasses() {
    allSpans.forEach((s) => s.el.classList.remove('active', 'done', 'pending'));
  }

  function updateRatioPanel(enPct, jpPct) {
    els.enRatioText.textContent = `EN AUDIO: ${enPct}%`;
    els.jpRatioText.textContent = `JP AUDIO: ${jpPct}%`;
    els.ratioBarEn.style.width = `${enPct}%`;
    els.ratioBarJp.style.width = `${jpPct}%`;
  }

  function tickHighlight() {
    if (!currentSource) return;
    const elapsed = actx.currentTime - playStartCtxTime;

    if (elapsed < 0) {
      rafHandle = requestAnimationFrame(tickHighlight);
      return;
    }

    let activeClipFound = false;

    for (const s of allSpans) {
      const isActive = elapsed >= s.start && elapsed < s.end;
      const isDone = elapsed >= s.end;
      s.el.classList.toggle('active', isActive);
      s.el.classList.toggle('done', isDone && !isActive);
      s.el.classList.toggle('pending', !isActive && !isDone);

      if (isActive && s.file) {
        activeClipFound = true;
        els.hudFileName.textContent = `[${s.phoneKey}] ${s.file}`;
        const isJp = s.origin === 'jp';
        els.hudOrigin.textContent = isJp ? '[JP]' : '[EN]';
        els.hudOrigin.className = `origin-tag ${isJp ? 'jp' : 'en'}`;
      }
    }

    if (!activeClipFound && elapsed < currentRender.duration) {
      els.hudFileName.textContent = 'CLIP: SILENCE / PAUSE';
      els.hudOrigin.textContent = '[---]';
      els.hudOrigin.className = 'origin-tag';
    }

    if (elapsed < currentRender.duration) {
      rafHandle = requestAnimationFrame(tickHighlight);
    }
  }

  function stopPlayback() {
    if (currentSource) {
      try { currentSource.onended = null; currentSource.stop(); } catch (e) { }
      currentSource = null;
    }
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    clearHighlightClasses();
    resetHudAndRatio();
    els.stopBtn.disabled = true;
    els.playBtn.disabled = !(libraryReady && dictReady);
  }

  async function playCurrentText() {
    const rawText = els.editable.textContent || '';
    if (!rawText.trim()) {
      setStatus('type something first.', 'err');
      return;
    }
    if (!libraryReady || !dictReady) {
      setStatus('still loading library...', 'err');
      return;
    }

    stopPlayback();
    setStatus('rendering...');
    els.playBtn.disabled = true;
    els.exportBtn.disabled = true;

    const built = buildPlan(rawText);
    if (!built.anyResolved) {
      setStatus('couldn\u2019t find any sounds for that text.', 'err');
      els.playBtn.disabled = false;
      return;
    }

    const rendered = await renderPlan(built);
    currentRender = { ...rendered, rawText };

    updateRatioPanel(rendered.enPct, rendered.jpPct);

    allSpans = renderHighlightMarkup(rawText, built.tokens, rendered.wordTimingList);

    if (actx.state === 'suspended') await actx.resume();

    const src = actx.createBufferSource();
    src.buffer = rendered.buffer;
    src.connect(analyser);
    src.onended = () => {
      if (currentSource === src) {
        stopPlayback();
        setStatus(built.hadOov ? 'done. (some words guessed because they were not in the dictionary)' : 'done.', 'ok');
      }
    };

    currentSource = src;
    const AUDIO_START_OFFSET = 0.08;
    const scheduledStart = actx.currentTime + AUDIO_START_OFFSET;
    playStartCtxTime = scheduledStart;
    src.start(scheduledStart);

    els.stopBtn.disabled = false;
    els.exportBtn.disabled = false;
    els.playBtn.disabled = false;
    setStatus(built.hadOov ? 'playing... (some words guessed because they were not in the dictionary)' : 'playing...');

    rafHandle = requestAnimationFrame(tickHighlight);
  }

  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const bufferSize = 44 + dataSize;

    const ab = new ArrayBuffer(bufferSize);
    const view = new DataView(ab);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, bufferSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) channelData.push(buffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channelData[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([ab], { type: 'audio/wav' });
  }

  function exportWav() {
    if (!currentRender) {
      setStatus('nothing rendered yet. click SPEAK first.', 'err');
      return;
    }
    const blob = audioBufferToWav(currentRender.buffer);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `jarona-tts-${stamp}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus('exported.', 'ok');
  }

  els.playBtn.addEventListener('click', playCurrentText);
  els.stopBtn.addEventListener('click', () => {
    stopPlayback();
    setStatus('stopped.');
  });
  els.exportBtn.addEventListener('click', exportWav);
  els.clearBtn.addEventListener('click', () => {
    stopPlayback();
    els.editable.innerHTML = '';
    currentRender = null;
    els.exportBtn.disabled = true;
    setStatus('\u00A0');
    els.editable.focus();
  });

  els.jpToggle.addEventListener('change', async (e) => {
    stopPlayback();
    useJpVoicelines = e.target.checked;
    currentRender = null;
    els.exportBtn.disabled = true;

    try {
      localStorage.setItem(LOCALSTORAGE_KEY_JP, JSON.stringify(useJpVoicelines));
    } catch (err) {
      console.warn('Could not save to localStorage:', err);
    }

    if (useJpVoicelines && !jpLoaded) {
      els.playBtn.disabled = true;
      await ensureJpLibraryLoaded();
      if (dictReady) els.playBtn.disabled = false;
    }

    if (libraryReady) {
      buildCandidatePools();
      updateReadyStatus();
    }
  });

  els.editable.addEventListener('input', () => {
    if (currentSource) stopPlayback();
    currentRender = null;
    els.exportBtn.disabled = true;
  });

  els.editable.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!els.playBtn.disabled) playCurrentText();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPlayback();
  });

  (async function boot() {
    els.playBtn.disabled = true;
    els.stopBtn.disabled = true;
    els.exportBtn.disabled = true;

    try {
      const specEN = { root: LIBRARY_ROOT_EN, manifestUrl: MANIFEST_URL_EN, origin: 'en' };
      const enPromise = loadLibrarySpec(specEN, (loaded, total) => {
        els.loadStatus.textContent = `loading phoneme libraries... ${loaded}/${total}`;
      });

      const promises = [enPromise, loadDict()];
      if (useJpVoicelines) {
        promises.push(ensureJpLibraryLoaded());
      }

      await Promise.all(promises);
      libraryReady = true;

      buildCandidatePools();
      updateReadyStatus();

      els.playBtn.disabled = false;
      setStatus('\u00A0');
      els.editable.focus();
    } catch (err) {
      console.error(err);
      els.loadStatus.textContent = 'failed to load libraries';
      setStatus(String(err.message || err), 'err');
    }
  })();
