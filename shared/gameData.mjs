const COLOR_SET = [
  { name: "Sunset Red", hex: "#de5b48" },
  { name: "Ocean Blue", hex: "#2d73da" },
  { name: "Lime Green", hex: "#35a468" },
  { name: "Golden Yellow", hex: "#d8aa1d" }
];

const EASY_ODD_SETS = [
  ["A", "4"],
  ["O", "0"],
  ["X", "K"],
  ["B", "8"]
];

const HARD_ODD_SETS = [
  ["M", "N"],
  ["P", "R"],
  ["U", "V"],
  ["C", "G"],
  ["E", "F"]
];

export const ROOM_STATES = [
  "WAITING",
  "LOCKED",
  "ROUND_INTRO",
  "PRACTICE_PLAY",
  "PRACTICE_RESULT",
  "MAIN_INTRO",
  "MAIN_PLAY",
  "PAUSED",
  "SCORING",
  "ROUND_RESULT",
  "FINAL_RESULT",
  "ENDED"
];

export const PLAYER_STATES = [
  "CONNECTED",
  "WAITING",
  "PRACTICING",
  "PRACTICE_DONE",
  "MAIN_PLAYING",
  "MAIN_DONE",
  "DISCONNECTED",
  "SPECTATING"
];

export function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createRng(seedInput) {
  let seed = typeof seedInput === "number" ? seedInput >>> 0 : hashString(String(seedInput));
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function shuffle(items, rng = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function pickUniqueIndices(total, count, rng) {
  return shuffle(Array.from({ length: total }, (_, index) => index), rng).slice(0, count);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildColorSnap(seed, mode) {
  const rng = createRng(seed);
  const totalSteps = mode === "practice" ? 8 : 12;
  const targetHits = mode === "practice" ? 2 : 3;
  const targetIndex = randomInt(rng, 0, COLOR_SET.length - 1);
  const targetSteps = pickUniqueIndices(totalSteps, targetHits, rng).sort((left, right) => left - right);
  const minDelay = mode === "practice" ? 700 : 350;
  const maxDelay = mode === "practice" ? 1000 : 850;
  const sequence = [];

  for (let index = 0; index < totalSteps; index += 1) {
    const isTarget = targetSteps.includes(index);
    let colorIndex = targetIndex;
    if (!isTarget) {
      const otherIndices = COLOR_SET.map((_, itemIndex) => itemIndex).filter((itemIndex) => itemIndex !== targetIndex);
      colorIndex = otherIndices[randomInt(rng, 0, otherIndices.length - 1)];
    }
    sequence.push({
      colorIndex,
      durationMs: randomInt(rng, minDelay, maxDelay)
    });
  }

  return {
    targetIndex,
    colors: COLOR_SET,
    sequence,
    totalDurationMs: sum(sequence.map((item) => item.durationMs)),
    timeLimitMs: sum(sequence.map((item) => item.durationMs)) + 800
  };
}

function buildGoStop(seed, mode) {
  const rng = createRng(seed);
  const totalSignals = mode === "practice" ? 8 : 12;
  const goCount = mode === "practice" ? 5 : randomInt(rng, 6, 8);
  const stops = Array(totalSignals - goCount).fill("STOP");
  const sequence = shuffle([...Array(goCount).fill("GO"), ...stops], rng).map((signal) => ({
    signal,
    durationMs: mode === "practice" ? 800 : 600
  }));
  return {
    sequence,
    totalDurationMs: sum(sequence.map((item) => item.durationMs)),
    timeLimitMs: sum(sequence.map((item) => item.durationMs)) + 800
  };
}

function buildNumberBoard(rng, questionType) {
  const values = pickUniqueIndices(90, 16, rng).map((value) => value + 10);
  let answerValue = values[0];
  let prompt = `숫자 ${values[0]} 찾기`;

  if (questionType === "max") {
    answerValue = Math.max(...values);
    prompt = "가장 큰 숫자 찾기";
  } else if (questionType === "min") {
    answerValue = Math.min(...values);
    prompt = "가장 작은 숫자 찾기";
  } else {
    answerValue = values[randomInt(rng, 0, values.length - 1)];
    prompt = `숫자 ${answerValue} 찾기`;
  }

  return {
    prompt,
    answerValue,
    values
  };
}

function buildNumberHunter(seed, mode) {
  const rng = createRng(seed);
  const questionCount = mode === "practice" ? 2 : 4;
  const types = mode === "practice" ? ["target", "target"] : shuffle(["target", "max", "min", "target"], rng);
  const questions = Array.from({ length: questionCount }, (_, index) => buildNumberBoard(rng, types[index] ?? "target"));
  return {
    questions,
    timeLimitMs: mode === "practice" ? 16000 : 22000
  };
}

function buildPatternMemory(seed, mode) {
  const rng = createRng(seed);
  const sequenceLength = mode === "practice" ? 4 : 6;
  const sequence = Array.from({ length: sequenceLength }, () => randomInt(rng, 0, 3));
  return {
    sequence,
    flashMs: mode === "practice" ? 650 : 560,
    gapMs: 180,
    timeLimitMs: mode === "practice" ? 14000 : 16000
  };
}

function buildPositionMemory(seed, mode) {
  const rng = createRng(seed);
  const count = mode === "practice" ? 3 : 5;
  const indices = pickUniqueIndices(9, count, rng).sort((left, right) => left - right);
  return {
    indices,
    revealMs: mode === "practice" ? 2500 : 3000,
    timeLimitMs: mode === "practice" ? 13000 : 14000
  };
}

function buildOddOneOut(seed, mode) {
  const rng = createRng(seed);
  const questionCount = mode === "practice" ? 2 : 4;
  const size = mode === "practice" ? 4 : 5;
  const pairs = mode === "practice" ? EASY_ODD_SETS : HARD_ODD_SETS;

  const questions = Array.from({ length: questionCount }, () => {
    const [base, odd] = pairs[randomInt(rng, 0, pairs.length - 1)];
    const total = size * size;
    const oddIndex = randomInt(rng, 0, total - 1);
    const cells = Array.from({ length: total }, (_, index) => (index === oddIndex ? odd : base));
    return {
      size,
      cells,
      oddIndex
    };
  });

  return {
    questions,
    timeLimitMs: mode === "practice" ? 18000 : 22000
  };
}

function buildTenSeconds(seed, mode) {
  return {
    targetMs: 10000,
    autoStopMs: 15000,
    hintMs: mode === "practice" ? 5000 : null,
    timeLimitMs: 18000
  };
}

function buildGaugeStop(seed, mode) {
  const rng = createRng(seed);
  const attempts = mode === "practice" ? 2 : 3;
  const speedBase = mode === "practice" ? 0.42 : 0.78;
  const zoneWidth = mode === "practice" ? 0.18 : 0.1;
  return {
    attempts: Array.from({ length: attempts }, (_, index) => ({
      targetCenter: clamp(0.2 + rng() * 0.6, 0.15, 0.85),
      speed: speedBase + rng() * (mode === "practice" ? 0.18 : 0.34),
      direction: index % 2 === 0 ? 1 : -1
    })),
    zoneWidth,
    timeLimitMs: mode === "practice" ? 14000 : 18000
  };
}

export const GAME_DEFINITIONS = {
  G01: {
    id: "G01",
    title: "컬러 스냅",
    description: "목표 색상이 나타나는 순간 패널을 빠르게 탭하세요.",
    intro: "목표 색상 이름을 보고 같은 색이 보일 때만 탭하세요.",
    category: "반응속도형",
    buildChallenge: buildColorSnap
  },
  G02: {
    id: "G02",
    title: "GO / STOP 탭",
    description: "GO일 때만 누르고 STOP에서는 누르지 마세요.",
    intro: "카드에 GO가 보일 때만 빠르게 탭하세요.",
    category: "반응속도형",
    buildChallenge: buildGoStop
  },
  G03: {
    id: "G03",
    title: "숫자 헌터",
    description: "조건에 맞는 숫자를 가장 빨리 찾아 탭하세요.",
    intro: "문제에 맞는 숫자를 숫자판에서 찾아보세요.",
    category: "탐색형",
    buildChallenge: buildNumberHunter
  },
  G04: {
    id: "G04",
    title: "점멸 패턴 기억",
    description: "깜빡인 순서를 기억한 뒤 같은 순서로 누르세요.",
    intro: "패드가 빛나는 순서를 외운 뒤 그대로 입력하세요.",
    category: "기억형",
    buildChallenge: buildPatternMemory
  },
  G05: {
    id: "G05",
    title: "위치 기억",
    description: "잠깐 보인 칸을 기억해 다시 고르세요.",
    intro: "표시된 칸을 기억한 뒤 같은 칸을 선택해 제출하세요.",
    category: "기억형",
    buildChallenge: buildPositionMemory
  },
  G06: {
    id: "G06",
    title: "다른 하나 찾기",
    description: "하나만 다른 문자를 가장 빨리 찾아내세요.",
    intro: "같아 보이는 문자들 사이에서 다른 하나를 탭하세요.",
    category: "관찰형",
    buildChallenge: buildOddOneOut
  },
  G07: {
    id: "G07",
    title: "10초 멈춰",
    description: "보이지 않는 타이머를 감각으로 맞춰 10초에 멈추세요.",
    intro: "10초라고 생각될 때 STOP을 눌러보세요.",
    category: "타이밍형",
    buildChallenge: buildTenSeconds
  },
  G08: {
    id: "G08",
    title: "게이지 스톱",
    description: "움직이는 게이지를 목표 구간에 최대한 가깝게 멈추세요.",
    intro: "움직이는 마커를 목표 구간에 최대한 맞춰 멈추세요.",
    category: "타이밍형",
    buildChallenge: buildGaugeStop
  }
};

export const ALL_GAME_IDS = Object.keys(GAME_DEFINITIONS);

export function selectGames(roundCount, seedInput = `${Date.now()}`) {
  const rng = createRng(seedInput);
  if (roundCount === 8) {
    return shuffle(ALL_GAME_IDS, rng);
  }
  return shuffle(ALL_GAME_IDS, rng).slice(0, 5);
}
