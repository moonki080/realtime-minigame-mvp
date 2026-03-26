function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function formatCountdown(deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  return `${(remaining / 1000).toFixed(1)}초`;
}

function formatSignedSeconds(diffMs) {
  const sign = diffMs >= 0 ? "+" : "-";
  return `${sign}${(Math.abs(diffMs) / 1000).toFixed(2)}초`;
}

function formatScore(value) {
  return `${Math.round(value)}점`;
}

function infoCard(label, value) {
  return `
    <div class="mini-stat">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function deadlineInfoCard(deadline, label = "제출 마감") {
  return `
    <div class="mini-stat mini-stat--deadline">
      <span>${label}</span>
      <strong data-deadline="${deadline}"></strong>
    </div>
  `;
}

function safeVibrate(pattern) {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate(pattern);
  }
}

function createRuntime(host, round, mode, onSubmit) {
  host.innerHTML = "";
  const root = document.createElement("section");
  root.className = "game-shell";
  host.append(root);

  const cleanup = {
    rafId: 0,
    timeouts: [],
    intervals: []
  };

  let submitted = false;

  function setFrame({ title, subtitle, badge, info = [], body }) {
    root.innerHTML = `
      <div class="game-header">
        <div>
          <span class="eyebrow">${badge}</span>
          <h2>${title}</h2>
          <p class="muted">${subtitle}</p>
        </div>
        <div class="game-header-side">
          <div class="pill neutral">${round.roundNumber}R</div>
          <div class="pill accent">${mode === "practice" ? "연습판" : "본게임"}</div>
        </div>
      </div>
      <div class="game-info-grid">
        ${info.join("")}
      </div>
      <div class="game-stage">${body}</div>
    `;
  }

  function timeout(task, delay) {
    const id = setTimeout(task, delay);
    cleanup.timeouts.push(id);
    return id;
  }

  function interval(task, delay) {
    const id = setInterval(task, delay);
    cleanup.intervals.push(id);
    return id;
  }

  function loop(task) {
    const step = () => {
      task();
      cleanup.rafId = requestAnimationFrame(step);
    };
    cleanup.rafId = requestAnimationFrame(step);
  }

  function stopLoops() {
    if (cleanup.rafId) {
      cancelAnimationFrame(cleanup.rafId);
      cleanup.rafId = 0;
    }
    cleanup.timeouts.forEach((id) => clearTimeout(id));
    cleanup.intervals.forEach((id) => clearInterval(id));
    cleanup.timeouts = [];
    cleanup.intervals = [];
  }

  async function submit(payload) {
    if (submitted) {
      return;
    }
    submitted = true;
    safeVibrate([28, 40, 28]);
    root.querySelector(".game-stage").innerHTML = `
      <div class="message-box message-box--submitted">
        <strong>제출 완료</strong>
        <p class="muted">${payload.metrics?.label || "기록이 저장되었습니다."}</p>
        <p class="tiny muted">${payload.metrics?.summary || "다른 참가자 결과를 기다리고 있습니다."}</p>
        <p class="tiny muted">같은 기기에서 다시 접속하면 현재 기록으로 복구됩니다.</p>
      </div>
    `;
    try {
      await onSubmit({
        ...payload,
        completedAt: payload.completedAt || Date.now()
      });
    } catch (error) {
      submitted = false;
      root.querySelector(".game-stage").innerHTML = `
        <div class="message-box error">
          ${(error instanceof Error ? error.message : "제출 중 오류가 발생했습니다.")}
        </div>
      `;
    }
  }

  return {
    root,
    round,
    mode,
    setFrame,
    timeout,
    interval,
    loop,
    stopLoops,
    feedback(kind) {
      if (kind === "correct") {
        safeVibrate(12);
      } else if (kind === "wrong") {
        safeVibrate([24, 32, 24]);
      } else if (kind === "soft") {
        safeVibrate(8);
      }
    },
    submit,
    destroy() {
      stopLoops();
      root.remove();
    }
  };
}

function mountColorSnap(runtime, context) {
  const { challenge, startedAt, endsAt } = context;
  const target = challenge.colors[challenge.targetIndex];
  const stepStarts = [];
  let cursor = startedAt;
  challenge.sequence.forEach((step) => {
    stepStarts.push(cursor);
    cursor += step.durationMs;
  });

  const stepState = challenge.sequence.map(() => ({
    tapped: false,
    correct: false,
    wrong: false,
    miss: false,
    rt: null
  }));

  let lastIndex = -1;
  let finished = false;

  runtime.setFrame({
    title: context.round.title,
    subtitle: "목표 색상이 나타나는 순간 패널을 탭하세요.",
    badge: "반응속도형",
    info: [
      infoCard("목표 색상", target.name),
      infoCard("등장 횟수", String(challenge.sequence.filter((step) => step.colorIndex === challenge.targetIndex).length)),
      deadlineInfoCard(endsAt)
    ],
    body: `
      <div class="full-tap-zone" id="color-zone">
        <button type="button" id="color-tap" aria-label="색상 패널 탭">
          준비 중...
        </button>
      </div>
      <div class="soft-card">
        <div class="progress-bar"><div class="progress-fill" id="color-progress"></div></div>
        <p id="color-status" class="muted tiny">카운트다운 후 시작합니다.</p>
      </div>
    `
  });

  const button = runtime.root.querySelector("#color-tap");
  const status = runtime.root.querySelector("#color-status");
  const progressFill = runtime.root.querySelector("#color-progress");

  function getStepIndex(now) {
    if (now < startedAt) {
      return -1;
    }
    for (let index = 0; index < challenge.sequence.length; index += 1) {
      const stepStart = stepStarts[index];
      const stepEnd = stepStart + challenge.sequence[index].durationMs;
      if (now >= stepStart && now < stepEnd) {
        return index;
      }
    }
    return challenge.sequence.length;
  }

  function finalizeStep(index) {
    if (index < 0 || index >= challenge.sequence.length) {
      return;
    }
    const step = challenge.sequence[index];
    const meta = stepState[index];
    if (step.colorIndex === challenge.targetIndex && !meta.tapped) {
      meta.miss = true;
    }
  }

  button.addEventListener("click", () => {
    const now = Date.now();
    const stepIndex = getStepIndex(now);
    if (finished || stepIndex < 0 || stepIndex >= challenge.sequence.length) {
      return;
    }
    const meta = stepState[stepIndex];
    if (meta.tapped) {
      return;
    }
    meta.tapped = true;
    const step = challenge.sequence[stepIndex];
    if (step.colorIndex === challenge.targetIndex) {
      meta.correct = true;
      meta.rt = Math.max(0, now - stepStarts[stepIndex]);
      runtime.feedback("correct");
      status.textContent = `정답 반응 ${meta.rt}ms`;
    } else {
      meta.wrong = true;
      runtime.feedback("wrong");
      status.textContent = "오탭 페널티";
    }
  });

  function finish() {
    if (finished) {
      return;
    }
    finished = true;
    runtime.stopLoops();
    finalizeStep(lastIndex);
    const correctEntries = stepState.filter((entry) => entry.correct);
    const wrongCount = stepState.filter((entry) => entry.wrong).length;
    const missCount = stepState.filter((entry) => entry.miss).length;
    const baseScore = correctEntries.reduce((total, entry) => total + Math.max(200, 1200 - (entry.rt ?? 1000)), 0);
    const score = Math.max(0, baseScore - wrongCount * 400 - missCount * 250);
    const lastCorrectRt = correctEntries.length ? correctEntries[correctEntries.length - 1].rt : 999999;
    runtime.submit({
      score,
      rankVector: [score, -lastCorrectRt],
      metrics: {
        label: `정답 ${correctEntries.length}/${challenge.sequence.filter((step) => step.colorIndex === challenge.targetIndex).length}`,
        summary: `오탭 ${wrongCount}회 · 미탭 ${missCount}회`
      }
    });
  }

  runtime.loop(() => {
    const now = Date.now();
    if (now >= endsAt || now >= startedAt + challenge.totalDurationMs) {
      finish();
      return;
    }
    if (now < startedAt) {
      button.textContent = target.name;
      button.parentElement.style.background = "rgba(255,255,255,0.94)";
      status.textContent = `시작까지 ${formatCountdown(startedAt)}`;
      return;
    }

    const stepIndex = getStepIndex(now);
    if (stepIndex !== lastIndex) {
      finalizeStep(lastIndex);
      lastIndex = stepIndex;
    }

    const step = challenge.sequence[clamp(stepIndex, 0, challenge.sequence.length - 1)];
    const color = challenge.colors[step.colorIndex];
    button.textContent = color.name;
    button.parentElement.style.background = color.hex;
    button.parentElement.style.color = step.colorIndex === 1 ? "white" : "#1f2d32";
    const progress = clamp(((now - startedAt) / challenge.totalDurationMs) * 100, 0, 100);
    progressFill.style.width = `${progress}%`;
  });
}

function mountGoStop(runtime, context) {
  const { challenge, startedAt, endsAt } = context;
  const stepStarts = [];
  let cursor = startedAt;
  challenge.sequence.forEach((step) => {
    stepStarts.push(cursor);
    cursor += step.durationMs;
  });
  const stepState = challenge.sequence.map(() => ({
    tapped: false,
    correct: false,
    wrong: false,
    miss: false,
    rt: null
  }));
  let lastIndex = -1;
  let finished = false;

  runtime.setFrame({
    title: context.round.title,
    subtitle: "GO 카드일 때만 탭하고 STOP은 참으세요.",
    badge: "억제 반응형",
    info: [
      infoCard("신호 수", String(challenge.sequence.length)),
      infoCard("GO 수", String(challenge.sequence.filter((item) => item.signal === "GO").length)),
      deadlineInfoCard(endsAt)
    ],
    body: `
      <div id="signal-card" class="signal-card">
        <button type="button" id="signal-button">준비 중...</button>
      </div>
      <div class="soft-card">
        <div class="progress-bar"><div class="progress-fill" id="signal-progress"></div></div>
        <p id="signal-status" class="muted tiny">카운트다운 후 시작합니다.</p>
      </div>
    `
  });

  const signalCard = runtime.root.querySelector("#signal-card");
  const button = runtime.root.querySelector("#signal-button");
  const progressFill = runtime.root.querySelector("#signal-progress");
  const status = runtime.root.querySelector("#signal-status");

  function getStepIndex(now) {
    if (now < startedAt) {
      return -1;
    }
    for (let index = 0; index < challenge.sequence.length; index += 1) {
      const stepStart = stepStarts[index];
      const stepEnd = stepStart + challenge.sequence[index].durationMs;
      if (now >= stepStart && now < stepEnd) {
        return index;
      }
    }
    return challenge.sequence.length;
  }

  function finalizeStep(index) {
    if (index < 0 || index >= challenge.sequence.length) {
      return;
    }
    const step = challenge.sequence[index];
    const meta = stepState[index];
    if (step.signal === "GO" && !meta.tapped) {
      meta.miss = true;
    }
  }

  button.addEventListener("click", () => {
    const now = Date.now();
    const stepIndex = getStepIndex(now);
    if (finished || stepIndex < 0 || stepIndex >= challenge.sequence.length) {
      return;
    }
    const meta = stepState[stepIndex];
    if (meta.tapped) {
      return;
    }
    meta.tapped = true;
    const signal = challenge.sequence[stepIndex].signal;
    if (signal === "GO") {
      meta.correct = true;
      meta.rt = Math.max(0, now - stepStarts[stepIndex]);
      runtime.feedback("correct");
      status.textContent = `GO 반응 ${meta.rt}ms`;
    } else {
      meta.wrong = true;
      runtime.feedback("wrong");
      status.textContent = "STOP에서 탭했습니다";
    }
  });

  function finish() {
    if (finished) {
      return;
    }
    finished = true;
    runtime.stopLoops();
    finalizeStep(lastIndex);
    const correctEntries = stepState.filter((entry) => entry.correct);
    const wrongCount = stepState.filter((entry) => entry.wrong).length;
    const missCount = stepState.filter((entry) => entry.miss).length;
    const baseScore = correctEntries.reduce((total, entry) => total + Math.max(100, 800 - (entry.rt ?? 800)), 0);
    const score = Math.max(0, baseScore - wrongCount * 400 - missCount * 250);
    const avgRt = correctEntries.length ? sum(correctEntries.map((entry) => entry.rt)) / correctEntries.length : 999999;
    runtime.submit({
      score,
      rankVector: [score, -avgRt],
      metrics: {
        label: `정답 ${correctEntries.length}/${challenge.sequence.filter((item) => item.signal === "GO").length}`,
        summary: `놓침 ${missCount}회 · 오탭 ${wrongCount}회`
      }
    });
  }

  runtime.loop(() => {
    const now = Date.now();
    if (now >= endsAt || now >= startedAt + challenge.totalDurationMs) {
      finish();
      return;
    }
    if (now < startedAt) {
      signalCard.className = "signal-card";
      button.textContent = "READY";
      status.textContent = `시작까지 ${formatCountdown(startedAt)}`;
      return;
    }

    const stepIndex = getStepIndex(now);
    if (stepIndex !== lastIndex) {
      finalizeStep(lastIndex);
      lastIndex = stepIndex;
    }

    const step = challenge.sequence[clamp(stepIndex, 0, challenge.sequence.length - 1)];
    signalCard.className = `signal-card ${step.signal.toLowerCase()}`;
    button.textContent = step.signal;
    progressFill.style.width = `${clamp(((now - startedAt) / challenge.totalDurationMs) * 100, 0, 100)}%`;
  });
}

function mountSequentialGrid(runtime, context, config) {
  const { challenge, startedAt, endsAt } = context;
  let currentIndex = 0;
  let questionStartedAt = startedAt;
  let finished = false;
  const answers = [];

  runtime.setFrame({
    title: context.round.title,
    subtitle: config.subtitle,
    badge: config.badge,
    info: [
      infoCard("문항 수", String(challenge.questions.length)),
      infoCard("현재 문항", `${currentIndex + 1}/${challenge.questions.length}`),
      deadlineInfoCard(endsAt)
    ],
    body: `
      <div class="soft-card">
        <h3 id="grid-prompt">곧 첫 문제를 보여줍니다.</h3>
        <p class="muted tiny" id="grid-subtext">${config.subtext}</p>
      </div>
      <div id="grid-board" class="${config.gridClass}"></div>
      <div class="soft-card">
        <div class="progress-bar"><div class="progress-fill" id="grid-progress"></div></div>
        <p class="muted tiny" id="grid-status">준비 중...</p>
      </div>
    `
  });

  const board = runtime.root.querySelector("#grid-board");
  const prompt = runtime.root.querySelector("#grid-prompt");
  const subtext = runtime.root.querySelector("#grid-subtext");
  const progressFill = runtime.root.querySelector("#grid-progress");
  const status = runtime.root.querySelector("#grid-status");

  function renderQuestion() {
    const question = challenge.questions[currentIndex];
    if (!question) {
      return;
    }
    prompt.textContent = config.prompt(question, currentIndex);
    subtext.textContent = `${currentIndex + 1}번째 문제`;
    board.className = config.gridClass + (question.size === 5 ? " large" : "");
    board.innerHTML = question.values
      ? question.values
          .map(
            (value, index) =>
              `<button type="button" class="grid-button" data-cell-index="${index}" data-cell-value="${value}">${value}</button>`
          )
          .join("")
      : question.cells
          .map(
            (value, index) =>
              `<button type="button" class="grid-button" data-cell-index="${index}" data-cell-value="${value}">${value}</button>`
          )
          .join("");
  }

  async function finish() {
    if (finished) {
      return;
    }
    finished = true;
    runtime.stopLoops();
    const score = sum(answers.map((entry) => entry.score));
    const totalResponse = sum(answers.map((entry) => entry.responseMs));
    await runtime.submit({
      score,
      rankVector: [score, -totalResponse],
      metrics: {
        label: `정답 ${answers.filter((entry) => entry.correct).length}/${challenge.questions.length}`,
        summary: `총 응답시간 ${(totalResponse / 1000).toFixed(2)}초`
      }
    });
  }

  board.addEventListener("click", (event) => {
    const button = event.target.closest("[data-cell-index]");
    if (!button || Date.now() < startedAt || finished || currentIndex >= challenge.questions.length) {
      return;
    }
    const question = challenge.questions[currentIndex];
    const chosenIndex = Number(button.dataset.cellIndex);
    const chosenValue = button.dataset.cellValue;
    const responseMs = Math.max(0, Date.now() - questionStartedAt);
    const correct = config.isCorrect(question, chosenIndex, chosenValue);
    answers.push({
      correct,
      responseMs,
      score: correct ? Math.max(200, 1000 - responseMs) : 0
    });
    runtime.feedback(correct ? "correct" : "wrong");
    status.textContent = correct ? `정답 ${responseMs}ms` : "오답, 다음 문제로 이동합니다.";
    currentIndex += 1;
    progressFill.style.width = `${clamp((answers.length / challenge.questions.length) * 100, 0, 100)}%`;
    if (currentIndex >= challenge.questions.length) {
      finish();
      return;
    }
    questionStartedAt = Date.now() + 280;
    runtime.timeout(renderQuestion, 260);
  });

  runtime.loop(() => {
    const now = Date.now();
    if (now >= endsAt) {
      finish();
      return;
    }
    if (now < startedAt) {
      status.textContent = `시작까지 ${formatCountdown(startedAt)}`;
      return;
    }
    if (!board.children.length) {
      renderQuestion();
      questionStartedAt = Date.now();
      status.textContent = "정답을 빠르게 탭하세요.";
    }
  });
}

function mountPatternMemory(runtime, context) {
  const { challenge, startedAt, endsAt } = context;
  let phase = "waiting";
  let input = [];
  let inputStartedAt = null;
  let replayUsed = false;
  let finished = false;

  runtime.setFrame({
    title: context.round.title,
    subtitle: "보여준 순서를 외운 뒤 그대로 탭하세요.",
    badge: "기억형",
    info: [
      infoCard("패턴 길이", `${challenge.sequence.length}단계`),
      infoCard("재생 간격", `${challenge.flashMs}ms`),
      deadlineInfoCard(endsAt)
    ],
    body: `
      <div class="soft-card">
        <h3 id="pattern-status">카운트다운 후 패턴을 보여드립니다.</h3>
        <p class="muted tiny">${context.mode === "practice" ? "연습판은 패턴 다시 보기를 1회 지원합니다." : "본게임은 실수 즉시 종료됩니다."}</p>
      </div>
      <div class="pattern-grid" id="pattern-grid">
        ${Array.from({ length: 4 }, (_, index) => `<button type="button" class="pattern-pad" data-pad="${index}">${index + 1}</button>`).join("")}
      </div>
      <div class="button-row">
        <button type="button" class="secondary" id="pattern-replay" ${context.mode === "main" ? "disabled" : ""}>패턴 다시 보기</button>
      </div>
    `
  });

  const status = runtime.root.querySelector("#pattern-status");
  const pads = [...runtime.root.querySelectorAll("[data-pad]")];
  const replayButton = runtime.root.querySelector("#pattern-replay");

  function flash(index) {
    pads[index].classList.add("active");
    runtime.timeout(() => {
      pads[index].classList.remove("active");
    }, challenge.flashMs - 50);
  }

  function playSequence() {
    phase = "demo";
    input = [];
    status.textContent = "패턴을 기억하세요.";
    challenge.sequence.forEach((padIndex, order) => {
      const delay = order * (challenge.flashMs + challenge.gapMs);
      runtime.timeout(() => flash(padIndex), delay);
    });
    runtime.timeout(() => {
      phase = "input";
      inputStartedAt = Date.now();
      status.textContent = "이제 같은 순서로 입력하세요.";
    }, challenge.sequence.length * (challenge.flashMs + challenge.gapMs));
  }

  async function finish(perfect) {
    if (finished) {
      return;
    }
    finished = true;
    runtime.stopLoops();
    const matched = input.length;
    const completionMs = Math.max(0, (Date.now() - (inputStartedAt || startedAt)));
    const score = matched * 200 + (perfect ? 400 : 0) + Math.max(0, Math.round(200 - completionMs / 40));
    await runtime.submit({
      score,
      rankVector: [matched, perfect ? 1 : 0, -completionMs, score],
      metrics: {
        label: `맞힌 단계 ${matched}/${challenge.sequence.length}`,
        summary: perfect ? "완벽 성공" : "실수로 종료"
      }
    });
  }

  pads.forEach((pad) => {
    pad.addEventListener("click", () => {
      if (phase !== "input" || finished) {
        return;
      }
      const chosen = Number(pad.dataset.pad);
      const expected = challenge.sequence[input.length];
      if (chosen !== expected) {
        runtime.feedback("wrong");
        status.textContent = "오입력으로 종료되었습니다.";
        finish(false);
        return;
      }
      input.push(chosen);
      runtime.feedback("correct");
      status.textContent = `${input.length}단계까지 성공`;
      if (input.length === challenge.sequence.length) {
        finish(true);
      }
    });
  });

  replayButton.addEventListener("click", () => {
    if (context.mode === "main" || replayUsed || phase !== "input") {
      return;
    }
    replayUsed = true;
    replayButton.disabled = true;
    playSequence();
  });

  runtime.loop(() => {
    const now = Date.now();
    if (now >= endsAt) {
      finish(false);
      return;
    }
    if (now < startedAt) {
      status.textContent = `시작까지 ${formatCountdown(startedAt)}`;
      return;
    }
    if (phase === "waiting") {
      playSequence();
    }
  });
}

function mountPositionMemory(runtime, context) {
  const { challenge, startedAt, endsAt } = context;
  let phase = "waiting";
  let finished = false;
  const selected = new Set();

  runtime.setFrame({
    title: context.round.title,
    subtitle: "기억한 칸을 골라 제출하세요.",
    badge: "기억형",
    info: [
      infoCard("기억할 칸", `${challenge.indices.length}개`),
      infoCard("노출 시간", `${(challenge.revealMs / 1000).toFixed(1)}초`),
      deadlineInfoCard(endsAt)
    ],
    body: `
      <div class="soft-card">
        <h3 id="memory-status">카운트다운 후 격자를 보여드립니다.</h3>
        <p class="muted tiny">선택한 칸은 진한 색으로 표시됩니다.</p>
      </div>
      <div class="memory-grid" id="memory-grid">
        ${Array.from({ length: 9 }, (_, index) => `<button type="button" class="memory-cell" data-cell="${index}">${index + 1}</button>`).join("")}
      </div>
      <div class="button-row">
        <button type="button" class="primary" id="memory-submit">선택 완료</button>
      </div>
    `
  });

  const status = runtime.root.querySelector("#memory-status");
  const cells = [...runtime.root.querySelectorAll("[data-cell]")];
  const submitButton = runtime.root.querySelector("#memory-submit");

  function updateSelectionStyles() {
    cells.forEach((cell) => {
      const index = Number(cell.dataset.cell);
      cell.classList.toggle("selected", selected.has(index));
    });
  }

  function reveal(on) {
    cells.forEach((cell) => {
      const index = Number(cell.dataset.cell);
      cell.classList.toggle("reveal", on && challenge.indices.includes(index));
    });
  }

  async function finish() {
    if (finished) {
      return;
    }
    finished = true;
    runtime.stopLoops();
    const correctCount = [...selected].filter((value) => challenge.indices.includes(value)).length;
    const wrongCount = [...selected].filter((value) => !challenge.indices.includes(value)).length;
    const perfect = correctCount === challenge.indices.length && wrongCount === 0;
    const submitAt = Date.now();
    const afterRevealMs = Math.max(0, submitAt - (startedAt + challenge.revealMs));
    const score = Math.max(0, correctCount * 200 - wrongCount * 100 + (perfect ? 300 : 0) + Math.max(0, 100 - Math.round(afterRevealMs / 50)));
    await runtime.submit({
      score,
      rankVector: [score, -afterRevealMs],
      metrics: {
        label: `정답 칸 ${correctCount}/${challenge.indices.length}`,
        summary: `오답 칸 ${wrongCount}개`
      }
    });
  }

  cells.forEach((cell) => {
    cell.addEventListener("click", () => {
      if (phase !== "select" || finished) {
        return;
      }
      const index = Number(cell.dataset.cell);
      if (selected.has(index)) {
        selected.delete(index);
      } else {
        selected.add(index);
        runtime.feedback("soft");
      }
      updateSelectionStyles();
      status.textContent = `${selected.size}칸 선택됨`;
    });
  });

  submitButton.addEventListener("click", finish);

  runtime.loop(() => {
    const now = Date.now();
    if (now >= endsAt) {
      finish();
      return;
    }
    if (now < startedAt) {
      status.textContent = `시작까지 ${formatCountdown(startedAt)}`;
      return;
    }
    if (phase === "waiting") {
      phase = "reveal";
      reveal(true);
      status.textContent = "표시된 칸을 외우세요.";
      runtime.timeout(() => {
        reveal(false);
        phase = "select";
        status.textContent = "이제 기억한 칸을 선택하세요.";
      }, challenge.revealMs);
    }
  });
}

function mountTenSeconds(runtime, context) {
  const { challenge, startedAt, endsAt } = context;
  let timerStartedAt = null;
  let hinted = false;
  let finished = false;

  runtime.setFrame({
    title: context.round.title,
    subtitle: "보이지 않는 타이머를 감각으로 맞춰 STOP을 눌러보세요.",
    badge: "타이밍형",
    info: [
      infoCard("목표 시간", "10.00초"),
      infoCard("자동 종료", "15초"),
      deadlineInfoCard(endsAt)
    ],
    body: `
      <div class="timer-card" id="timer-card">
        <button type="button" id="timer-button">START</button>
      </div>
      <div class="soft-card">
        <p id="timer-status" class="muted">시작 버튼을 누른 뒤 10초라고 느껴질 때 STOP을 누르세요.</p>
      </div>
    `
  });

  const button = runtime.root.querySelector("#timer-button");
  const timerCard = runtime.root.querySelector("#timer-card");
  const status = runtime.root.querySelector("#timer-status");

  async function finish(elapsedMs, manual = true) {
    if (finished) {
      return;
    }
    finished = true;
    runtime.stopLoops();
    if (elapsedMs == null) {
      await runtime.submit({
        score: 0,
        rankVector: [0, -999999],
        metrics: {
          label: "미응답",
          summary: "시작 또는 정지를 하지 못했습니다."
        }
      });
      return;
    }
    const errorMs = Math.abs(elapsedMs - challenge.targetMs);
    const score = Math.max(0, Math.round(1000 - errorMs / 5));
    await runtime.submit({
      score,
      rankVector: [score, -errorMs],
      metrics: {
        label: `오차 ${formatSignedSeconds(elapsedMs - challenge.targetMs)}`,
        summary: manual ? "직접 STOP 제출" : "자동 종료로 제출"
      }
    });
  }

  button.addEventListener("click", () => {
    if (Date.now() < startedAt || finished) {
      return;
    }
    if (!timerStartedAt) {
      timerStartedAt = Date.now();
      runtime.feedback("soft");
      button.textContent = "STOP";
      timerCard.style.background = "rgba(31, 111, 104, 0.12)";
      timerCard.style.color = "#1f6f68";
      status.textContent = "10초를 느껴보세요.";
      return;
    }
    runtime.feedback("correct");
    finish(Date.now() - timerStartedAt, true);
  });

  runtime.loop(() => {
    const now = Date.now();
    if (now >= endsAt) {
      finish(timerStartedAt ? now - timerStartedAt : null, false);
      return;
    }
    if (now < startedAt) {
      status.textContent = `시작까지 ${formatCountdown(startedAt)}`;
      return;
    }
    if (timerStartedAt) {
      const elapsed = now - timerStartedAt;
      if (context.mode === "practice" && challenge.hintMs && !hinted && elapsed >= challenge.hintMs) {
        hinted = true;
        status.textContent = "연습 힌트: 이제 절반쯤 지났습니다.";
      }
      if (elapsed >= challenge.autoStopMs) {
        finish(challenge.autoStopMs, false);
      }
    }
  });
}

function mountGaugeStop(runtime, context) {
  const { challenge, startedAt, endsAt } = context;
  let attemptIndex = 0;
  let attemptStartedAt = startedAt;
  let transitionUntil = null;
  const results = [];
  let finished = false;

  runtime.setFrame({
    title: context.round.title,
    subtitle: "움직이는 마커를 목표 구간에 최대한 가깝게 멈추세요.",
    badge: "타이밍형",
    info: [
      infoCard("시도 수", String(challenge.attempts.length)),
      infoCard("목표 폭", `${Math.round(challenge.zoneWidth * 100)}%`),
      deadlineInfoCard(endsAt)
    ],
    body: `
      <div class="soft-card">
        <h3 id="gauge-status">카운트다운 후 게이지가 움직입니다.</h3>
        <p class="muted tiny">현재 시도: <span id="gauge-attempt-label">1</span> / ${challenge.attempts.length}</p>
      </div>
      <div class="gauge-track">
        <div class="gauge-target" id="gauge-target"></div>
        <div class="gauge-marker" id="gauge-marker"></div>
      </div>
      <div class="button-row">
        <button type="button" class="primary" id="gauge-stop">STOP</button>
      </div>
    `
  });

  const status = runtime.root.querySelector("#gauge-status");
  const attemptLabel = runtime.root.querySelector("#gauge-attempt-label");
  const targetEl = runtime.root.querySelector("#gauge-target");
  const markerEl = runtime.root.querySelector("#gauge-marker");
  const stopButton = runtime.root.querySelector("#gauge-stop");

  function currentAttempt() {
    return challenge.attempts[attemptIndex];
  }

  function currentPosition(now) {
    const attempt = currentAttempt();
    const elapsed = Math.max(0, now - attemptStartedAt);
    const travel = (elapsed / 1000) * attempt.speed;
    const offset = attempt.direction === 1 ? travel : travel + 0.5;
    const cycle = offset % 2;
    return cycle <= 1 ? cycle : 2 - cycle;
  }

  function updateTarget() {
    const attempt = currentAttempt();
    const left = clamp(attempt.targetCenter - challenge.zoneWidth / 2, 0, 1);
    targetEl.style.left = `${left * 100}%`;
    targetEl.style.width = `${challenge.zoneWidth * 100}%`;
    attemptLabel.textContent = String(attemptIndex + 1);
  }

  async function finish() {
    if (finished) {
      return;
    }
    finished = true;
    runtime.stopLoops();
    const totalScore = sum(results.map((item) => item.score));
    const bestScore = results.length ? Math.max(...results.map((item) => item.score)) : 0;
    await runtime.submit({
      score: totalScore,
      rankVector: [totalScore, bestScore],
      metrics: {
        label: `합산 ${formatScore(totalScore)}`,
        summary: `최고 시도 ${formatScore(bestScore)}`
      }
    });
  }

  function advanceAttempt() {
    if (attemptIndex >= challenge.attempts.length - 1) {
      finish();
      return;
    }
    attemptIndex += 1;
    attemptStartedAt = Date.now() + 450;
    transitionUntil = attemptStartedAt;
    updateTarget();
    status.textContent = "다음 시도를 준비합니다.";
  }

  stopButton.addEventListener("click", () => {
    const now = Date.now();
    if (finished || now < startedAt || transitionUntil && now < transitionUntil) {
      return;
    }
    const position = currentPosition(now);
    const attempt = currentAttempt();
    const distanceRatio = Math.min(1, Math.abs(position - attempt.targetCenter) * 1.4);
    const score = Math.max(0, Math.round(1000 * (1 - distanceRatio)));
    runtime.feedback(score >= 700 ? "correct" : score >= 400 ? "soft" : "wrong");
    results.push({ score });
    status.textContent = `시도 ${attemptIndex + 1}: ${formatScore(score)}`;
    advanceAttempt();
  });

  updateTarget();

  runtime.loop(() => {
    const now = Date.now();
    if (now >= endsAt) {
      finish();
      return;
    }
    if (now < startedAt) {
      status.textContent = `시작까지 ${formatCountdown(startedAt)}`;
      return;
    }
    if (transitionUntil && now < transitionUntil) {
      return;
    }
    transitionUntil = null;
    markerEl.style.left = `${currentPosition(now) * 100}%`;
  });
}

export function mountGameController(host, context) {
  const mode = context.mode;
  const challenge = mode === "practice" ? context.round.practiceConfig : context.round.mainConfig;
  const startedAt = mode === "practice" ? context.round.practiceStartedAt : context.round.mainStartedAt;
  const endsAt = mode === "practice" ? context.round.practiceEndsAt : context.round.mainEndsAt;
  const runtime = createRuntime(host, context.round, mode, context.onSubmit);
  const stageContext = {
    ...context,
    challenge,
    startedAt,
    endsAt
  };

  switch (context.round.gameId) {
    case "G01":
      mountColorSnap(runtime, stageContext);
      break;
    case "G02":
      mountGoStop(runtime, stageContext);
      break;
    case "G03":
      mountSequentialGrid(runtime, stageContext, {
        subtitle: "문제 조건에 맞는 숫자를 4x4 보드에서 찾아보세요.",
        subtext: "오답이면 해당 문항은 0점 처리됩니다.",
        badge: "탐색형",
        gridClass: "number-grid",
        prompt: (question) => question.prompt,
        isCorrect: (question, _index, chosenValue) => Number(chosenValue) === question.answerValue
      });
      break;
    case "G04":
      mountPatternMemory(runtime, stageContext);
      break;
    case "G05":
      mountPositionMemory(runtime, stageContext);
      break;
    case "G06":
      mountSequentialGrid(runtime, stageContext, {
        subtitle: "하나만 다른 문자를 찾아 빠르게 탭하세요.",
        subtext: "오답이면 다음 문제로 넘어갑니다.",
        badge: "관찰형",
        gridClass: "odd-grid",
        prompt: (_question, index) => `문제 ${index + 1}: 다른 문자 하나 찾기`,
        isCorrect: (question, chosenIndex) => chosenIndex === question.oddIndex
      });
      break;
    case "G07":
      mountTenSeconds(runtime, stageContext);
      break;
    case "G08":
      mountGaugeStop(runtime, stageContext);
      break;
    default:
      runtime.setFrame({
        title: context.round.title,
        subtitle: "이 게임은 아직 연결되지 않았습니다.",
        badge: "준비 중",
        body: `<div class="message-box">게임 구현 준비 중입니다.</div>`
      });
  }

  return runtime;
}
