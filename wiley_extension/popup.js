let autoNextEnabled = false;

// --- UI Helpers ---

function setStep(stepNum, state) {
  for (let i = 1; i <= 6; i++) {
    const el = document.getElementById('step' + i);
    if (!el) continue;
    el.className = 'step';
    if (i < stepNum) el.classList.add('done');
    else if (i === stepNum) el.classList.add(state || 'active');
  }
  const labels = ['', 'Scraping page', 'Sending to AI', 'Waiting for AI', 'Parsing response', 'Filling answers', 'Submitting'];
  const labelEl = document.getElementById('stepLabel');
  if (labelEl) labelEl.textContent = stepNum > 0 && stepNum <= 6 ? labels[stepNum] : '';
}

async function countdown(seconds, label) {
  const el = document.getElementById('countdown');
  const status = document.getElementById('status');
  for (let i = seconds; i > 0; i--) {
    if (el) el.textContent = `${label}: ${i}s`;
    if (status) status.innerText = `${label} (${i}s remaining)...`;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (el) el.textContent = '';
}

function clearUI() {
  const el = document.getElementById('countdown');
  const labelEl = document.getElementById('stepLabel');
  if (el) el.textContent = '';
  if (labelEl) labelEl.textContent = '';
  for (let i = 1; i <= 6; i++) {
    const step = document.getElementById('step' + i);
    if (step) step.className = 'step';
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) { try { return JSON.parse(jsonBlock[1].trim()); } catch {} }
  const codeBlock = text.match(/```\s*([\s\S]*?)```/);
  if (codeBlock) { try { return JSON.parse(codeBlock[1].trim()); } catch {} }
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) { try { return JSON.parse(braceMatch[0]); } catch {} }
  return null;
}

function safeStorageSet(obj) {
  try { chrome.storage.local.set(obj); } catch {}
}

// --- Scraper (broad selectors) ---

async function scrapeFullState(tab) {
  console.log("[Scrape] scrapeFullState: tab =", tab.url);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const inputs = Array.from(document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([hidden]), input[type="number"]:not([readonly]):not([hidden])'
      )).filter(inp => {
        const id = (inp.id || '').toLowerCase();
        const cls = (inp.className || '').toLowerCase();
        return !id.includes('search') && !cls.includes('search');
      });

      const states = inputs.map(inp => ({
        value: inp.value,
        invalid: inp.getAttribute('aria-invalid') === 'true' || inp.classList.contains('invalid')
      }));

      let text = '';
      let isolatedCount = 0;
      const firstEmpty = inputs.find(inp => inp.value.trim() === '');
      if (firstEmpty) {
        let el = firstEmpty.closest('.question-content, .problem-statement, section.question, .assessment-question, [class*="question"], [class*="problem"]');
        if (!el) el = firstEmpty.parentElement;
        if (el && el !== document.body) {
          const clone = el.cloneNode(true);
          clone.querySelectorAll('script, style, nav, header, footer, .navigation, .sidebar').forEach(e => e.remove());
          text = clone.innerText;
          isolatedCount = el.querySelectorAll('input[type="text"]:not([readonly]):not([hidden]), input[type="number"]:not([readonly]):not([hidden])').length;
        }
      }
      if (!text) {
        const cloned = document.body.cloneNode(true);
        cloned.querySelectorAll('script, style, nav, header, footer, .navigation, .sidebar').forEach(e => e.remove());
        text = cloned.innerText;
      }
      return JSON.stringify({ text, inputStates: states, inputCount: isolatedCount || inputs.length });
    }
  });
  const parsed = results.map(r => JSON.parse(r.result));
  return {
    text: parsed.map(p => p.text).filter(t => t).join("\n\n--- Frame Boundary ---\n\n"),
    inputStates: parsed.flatMap(p => p.inputStates),
    inputCount: Math.max(...parsed.filter(p => p.text).map(p => p.inputCount), 0)
  };
}

// --- Fill Answers (broad selectors) ---

async function fillAnswers(tab, answers) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (ans) => {
      const numberInputs = Array.from(document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([hidden]), input[type="number"]:not([readonly]):not([hidden])'
      )).filter(inp => {
        const id = (inp.id || '').toLowerCase();
        const cls = (inp.className || '').toLowerCase();
        return !id.includes('search') && !cls.includes('search');
      });
      const unitSelects = Array.from(document.querySelectorAll('select'));

      ans.forEach((a, i) => {
        if (numberInputs[i] && a.correct !== true) {
          numberInputs[i].value = a.value;
          numberInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          numberInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (unitSelects[i] && a.correct !== true) {
          const opt = Array.from(unitSelects[i].options).find(o => o.textContent.trim().toLowerCase() === String(a.unit).toLowerCase());
          if (opt) {
            unitSelects[i].value = opt.value;
            unitSelects[i].dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
    },
    args: [answers]
  });
}

async function checkInputsFilled(tab) {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const inputs = Array.from(document.querySelectorAll('input[aria-label="Enter your answer"]'));
      return inputs.every(inp => inp.value && inp.value.trim() !== '');
    }
  });
  return r.some(rr => rr.result === true);
}

// --- Server calls ---

async function callServerSolve(text, inputCount) {
  console.log("[Server] callServerSolve:", inputCount, "answers needed");
  const response = await fetch('http://127.0.0.1:5000/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, input_count: inputCount })
  });
  if (!response.ok) throw new Error(`Server error ${response.status}`);
  return await response.json();
}

async function callServerRetry(text, previousAnswers, feedbackText, attempt) {
  console.log("[Server] callServerRetry: attempt", attempt);
  const response = await fetch('http://127.0.0.1:5000/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_text: text, previous_answers: previousAnswers, feedback_text: feedbackText, attempt, input_count: previousAnswers.length })
  });
  if (!response.ok) throw new Error(`Retry error ${response.status}`);
  return await response.json();
}

async function callGeminiWeb(problemText, inputCount, retryContext, wileyTabId) {
  console.log("[Gemini] callGeminiWeb via server /gemini-web");
  let prompt;
  if (retryContext) {
    prompt = `The answers you gave for this problem were checked and some were marked incorrect. Fix only the wrong ones.\n\nPROBLEM:\n${problemText}\n\nPREVIOUS ANSWERS:\n${JSON.stringify(retryContext.previousAnswers)}\n\nFEEDBACK:\n${retryContext.feedbackText}\n\nThe answers marked "correct": true were accepted. DO NOT change them.\nOnly fix the answers marked "correct": false.\n\nReturn EXACTLY ${inputCount} answers. Return ONLY this JSON:\n{"answers":[{"value":"number","unit":"unit"},...],"reasoning":"..."}`;
  } else {
    prompt = `Solve this physics problem. Return EXACTLY ${inputCount} answers.\n\nRules:\n- "value" must be ONLY a number. No ranges, no units in value.\n- "unit" must be one of: "s", "m", "m/s", "m/s^2", "cm/s^2", "No units", "km/h", "km", "min"\n\nReturn ONLY this JSON (no other text):\n{"answers":[{"value":"number","unit":"unit"},...],"reasoning":"..."}\n\nPROBLEM:\n${problemText}`;
  }
  try {
    const response = await fetch('http://127.0.0.1:5000/gemini-web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.log("[Gemini] Server fetch failed:", e.message);
    return null;
  }
}

async function callGroqDirect(text, inputCount, retryContext) {
  let key = await new Promise(res => chrome.storage.local.get('groqKey', d => res(d.groqKey || '')));
  if (!key) return null;
  console.log("[Groq] Calling API directly...");
  const systemMsg = retryContext
    ? `Fix wrong answers. Previous: ${JSON.stringify(retryContext.previousAnswers)}. Feedback: ${retryContext.feedbackText}. Return EXACTLY ${inputCount} answers. JSON: {"answers":[{"value":"number","unit":"unit"},...]}`
    : `Solve physics. Return EXACTLY ${inputCount} answers. "value"=number only, "unit"=s|m|m/s|m/s^2|cm/s^2|No units|km/h|km|min. JSON: {"answers":[{"value":"number","unit":"unit"},...],"reasoning":"..."}`;
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: text }], temperature: 0.1, max_tokens: 2000 })
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return extractJSON(data.choices?.[0]?.message?.content);
}

async function checkServerAlive() {
  try { const r = await fetch('http://127.0.0.1:5000/', { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}

// --- Answer cleaning ---

function cleanAnswersExtension(answers) {
  return answers.map(a => {
    let val = String(a.value || '').trim();
    const unit = String(a.unit || 'No units').trim();
    if (val.startsWith('+')) val = val.slice(1);
    if (/to|–|-/.test(val)) {
      const parts = val.match(/[\d.]+/g);
      if (parts && parts.length >= 2) val = String((parseFloat(parts[0]) + parseFloat(parts[1])) / 2);
    }
    const firstNum = val.match(/[\d.]+/);
    if (firstNum) val = firstNum[0];
    if (isNaN(parseFloat(val))) val = '';
    return { value: val, unit, correct: a.correct };
  });
}

function validateAnswers(answers) {
  answers.forEach((a, i) => {
    const val = String(a.value).trim();
    if (val === '' || isNaN(parseFloat(val))) throw new Error(`Answer ${i+1}: "${a.value}" is not a valid number`);
    a.value = val;
  });
}

// --- Submit & Next ---

async function clickSubmit(tab) {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const selectors = [
        'button.btn.btn-primary.was-submit-answer.m-l-h',
        'button.was-submit-answer',
        'button[data-testid="submit-answer"]',
        'button[aria-label*="Submit"]',
        '.submit-button',
        'button.MuiButton-root[type="submit"]'
      ];
      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) { btn.click(); return { success: true, selector: sel }; }
        } catch {}
      }
      return { success: false };
    }
  });
  return r.some(rr => rr.result?.success === true);
}

async function clickSubmitFallback(tab) {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const selectors = [
        'button.was-submit-answer:not(.btn-primary)',
        'button.btn-primary:not(.was-submit-answer)',
        'button[type="submit"]',
        'input[type="submit"]',
        '[role="button"][aria-label*="Submit"]',
        '.submit-button',
        'button.MuiButton-root[type="submit"]'
      ];
      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) { btn.click(); return true; }
        } catch {}
      }
      return false;
    }
  });
  return r.some(rr => rr.result === true);
}

async function clickNext(tab) {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const selectors = [
        'button[data-testid="next-button"]',
        'button[title="Next question"]',
        'button[aria-label="Next question"]',
        'button[aria-label="Next"]',
        'button.MuiIconButton-root[title="Next question"]',
        'button.MuiButtonBase-root[title="Next question"]',
        'path[d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"]',
        '.MuiIconButton-root[title="Next question"]',
        'button[title*="Next"]'
      ];
      for (const sel of selectors) {
        try {
          let btn = document.querySelector(sel);
          if (!btn && sel.startsWith('path[')) {
            const path = document.querySelector(sel);
            if (path) btn = path.closest('button, a, [role="button"]');
          }
          if (btn && btn.offsetParent !== null) { btn.click(); return { success: true }; }
        } catch {}
      }
      return { success: false };
    }
  });
  return r.some(rr => rr.result?.success === true);
}

// --- Auto debug ---

async function autoDebugPage(tab) {
  console.log("[AutoDebug] Running backend page inspection...");
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"]')).map((inp, i) => ({
        index: i, type: inp.type, ariaLabel: inp.getAttribute('aria-label'), value: inp.value, classes: inp.className, id: inp.id
      }));
      const submitBtns = Array.from(document.querySelectorAll('button, input[type="submit"]')).map((btn, i) => ({
        index: i, tag: btn.tagName, text: btn.innerText?.trim(), classes: btn.className, visible: btn.offsetParent !== null
      }));
      return { inputs, submitBtns };
    }
  });
  if (r[0]?.result) {
    safeStorageSet({ lastAutoDebug: { timestamp: new Date().toLocaleTimeString(), data: r[0].result } });
    console.log("[AutoDebug] DIAGNOSTICS SAVED");
  }
}

// --- Get tabs ---

async function getWileyTab() {
  const patterns = ['*://*.wiley.com/*', '*://*.wileyplus.com/*', '*://*.wileyplus.knowmia.com/*'];
  for (const p of patterns) {
    const tabs = await chrome.tabs.query({ url: p });
    if (tabs.length > 0) return tabs[0];
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && !tab.url.includes('gemini.google.com')) return tab;
  return tab;
}

async function handleSuccess(answers, status, resultDiv, wileyTab) {
  const text = answers.map(a => `${a.value} ${a.unit}`).join('\n');
  status.innerText = "All correct!";
  resultDiv.innerText = text;
  resultDiv.style.display = "block";
  safeStorageSet({ lastResult: { text, timestamp: new Date().toLocaleTimeString() } });
  if (autoNextEnabled) {
    status.innerText = "All correct! Moving to next...";
    await sleep(1500);
    const nextResult = await clickNext(wileyTab);
    if (nextResult.some(r => r.result?.success)) {
      status.innerText = "Moved to next question.";
    } else {
      resultDiv.innerText = text + "\n\n[Auto-next: next button not found]";
    }
  }
}

// --- MAIN SOLVE ---

async function solve() {
  const status = document.getElementById('status');
  const btn = document.getElementById('solveBtn');
  const resultDiv = document.getElementById('result');
  btn.disabled = true;
  resultDiv.style.display = "none";

  try {
    const tab = await getWileyTab();
    if (!tab) throw new Error("No WileyPLUS tab open. Open a problem first.");

    setStep(1, 'active');
    status.innerText = "Scraping...";
    const state = await scrapeFullState(tab);
    if (!state.text || state.text.trim().length === 0) throw new Error("Could not find any text on the page.");
    if (state.inputCount === 0) {
      await autoDebugPage(tab);
      throw new Error("Found 0 input fields. Debug data saved.");
    }

    setStep(2, 'active');
    status.innerText = "Asking Gemini (web)...";
    let data = await callGeminiWeb(state.text, state.inputCount, undefined, tab.id);
    let usedGemini = !!data;

    if (!data || !data.answers) {
      console.log("[Solve] Gemini unavailable, trying Groq direct...");
      setStep(2, 'active');
      status.innerText = "Gemini unavailable, using Groq...";
      data = await callGroqDirect(state.text, state.inputCount);
      usedGemini = false;
    }

    if (!data || !data.answers) {
      const serverAlive = await checkServerAlive();
      if (serverAlive) {
        setStep(2, 'active');
        status.innerText = "Groq unavailable, using server...";
        data = await callServerSolve(state.text, state.inputCount);
      } else {
        throw new Error("No AI available. Start the server or set a Groq key.");
      }
    }

    if (!data || !data.answers) throw new Error("AI returned no answers.");

    setStep(3, 'active');
    data.answers = cleanAnswersExtension(data.answers);
    validateAnswers(data.answers);

    setStep(4, 'active');
    status.innerText = "Filling answers...";
    await fillAnswers(tab, data.answers);

    // Pre-submit fill retry
    let filled = false;
    for (let fillAttempt = 0; fillAttempt < 3; fillAttempt++) {
      if (fillAttempt > 0) {
        console.log("[Solve] Re-filling attempt", fillAttempt + 1);
        await fillAnswers(tab, data.answers);
      }
      await sleep(1500);
      filled = await checkInputsFilled(tab);
      if (filled) break;
    }

    setStep(5, 'active');
    status.innerText = "Submitting...";
    const submitResult = await clickSubmit(tab);
    const submitClicked = submitResult;
    if (!submitClicked) {
      const fbResult = await clickSubmitFallback(tab);
      if (!fbResult) {
        console.warn("[Solve] All submit buttons failed, triggering auto-debug...");
        await autoDebugPage(tab);
      }
    }

    await sleep(7000);

    // Check results
    let postState = await scrapeFullState(tab);
    while (data.answers.length < postState.inputStates.length) {
      data.answers.push({ value: '', unit: 'No units' });
    }
    let currentAnswers = postState.inputStates.map((s, i) => ({
      ...data.answers[i],
      correct: !s.invalid && s.value !== ''
    }));

    let hadErrors = currentAnswers.some(a => a.correct === false);
    if (!hadErrors) {
      setStep(6, 'done');
      await handleSuccess(currentAnswers, status, resultDiv, tab);
      return;
    }

    // Retry loop
    for (let attempt = 1; attempt <= 3; attempt++) {
      status.innerText = `Retry ${attempt}: fixing wrong answers...`;
      let retryData;
      if (usedGemini) {
        retryData = await callGeminiWeb(state.text, state.inputCount, { previousAnswers: currentAnswers, feedbackText: postState.text }, tab.id);
      }
      if (!retryData || !retryData.answers) {
        const serverAlive = await checkServerAlive();
        if (serverAlive) {
          retryData = await callServerRetry(state.text, currentAnswers, postState.text, attempt);
        }
      }
      if (!retryData || !retryData.answers) break;

      retryData.answers = cleanAnswersExtension(retryData.answers);
      if (retryData.action === 'done' || currentAnswers.every(a => a.correct === true)) {
        await handleSuccess(currentAnswers, status, resultDiv, tab);
        return;
      }
      validateAnswers(retryData.answers);

      while (retryData.answers.length < currentAnswers.length) {
        retryData.answers.push({ value: '', unit: 'No units' });
      }
      currentAnswers = currentAnswers.map((old, i) => {
        if (old.correct === true) return old;
        return { ...retryData.answers[i], correct: false };
      });

      await fillAnswers(tab, currentAnswers);
      await sleep(1500);
      const retryFilled = await checkInputsFilled(tab);
      if (!retryFilled) continue;

      let retrySubmitResult = await clickSubmit(tab);
      if (!retrySubmitResult) {
        retrySubmitResult = await clickSubmitFallback(tab);
        if (!retrySubmitResult) {
          await autoDebugPage(tab);
        }
      }
      await sleep(7000);

      postState = await scrapeFullState(tab);
      currentAnswers = postState.inputStates.map((s, i) => ({
        ...currentAnswers[i],
        correct: !s.invalid && s.value !== ''
      }));

      if (currentAnswers.every(a => a.correct === true)) {
        await handleSuccess(currentAnswers, status, resultDiv, tab);
        return;
      }
    }

    setStep(6, 'error');
    status.innerText = "Some answers still wrong after retries.";
    resultDiv.innerText = currentAnswers.map(a => `${a.value} ${a.unit} [${a.correct ? 'OK' : 'WRONG'}]`).join('\n');
    resultDiv.style.display = "block";

  } catch (e) {
    status.innerText = "Error";
    resultDiv.innerText = e.message;
    resultDiv.style.display = "block";
    console.error(e);
  } finally {
    btn.disabled = false;
    setTimeout(clearUI, 3000);
  }
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('solveBtn').addEventListener('click', solve);

  // Auto-next toggle
  const autoNextToggle = document.getElementById('autoNextToggle');
  if (autoNextToggle) {
    chrome.storage.local.get('autoNextEnabled', d => {
      autoNextEnabled = !!d.autoNextEnabled;
      autoNextToggle.checked = autoNextEnabled;
    });
    autoNextToggle.addEventListener('change', () => {
      autoNextEnabled = autoNextToggle.checked;
      safeStorageSet({ autoNextEnabled });
    });
  }

  // Server status check
  async function checkServer() {
    const dot = document.getElementById('serverDot');
    const label = document.getElementById('serverLabel');
    const alive = await checkServerAlive();
    if (dot) dot.className = alive ? 'dot green' : 'dot red';
    if (label) label.textContent = alive ? 'Server: connected' : 'Server: offline';
  }
  checkServer();
  setInterval(checkServer, 10000);
});
