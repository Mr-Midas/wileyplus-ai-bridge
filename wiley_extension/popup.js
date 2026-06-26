let autoNextEnabled = false;

// --- UI Helpers (countdown + step bar) ---

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

// --- Gemini Web helpers ---

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

async function callGeminiWeb(problemText, inputCount, retryContext, wileyTabId) {
  console.log("[Gemini] callGeminiWeb: inputCount =", inputCount, "retry =", !!retryContext);

  // Build prompt
  let prompt;
  if (retryContext) {
    prompt = `The answers you gave for this problem were checked and some were marked incorrect. Fix only the wrong ones.

PROBLEM:
${problemText}

PREVIOUS ANSWERS:
${JSON.stringify(retryContext.previousAnswers)}

FEEDBACK:
${retryContext.feedbackText}

The answers marked "correct": true were accepted. DO NOT change them.
Only fix the answers marked "correct": false.

Return EXACTLY ${inputCount} answers. Return ONLY this JSON:
{"answers":[{"value":"number","unit":"unit"},...],"reasoning":"..."}`;
  } else {
    prompt = `Solve this physics problem. Return EXACTLY ${inputCount} answers.

Rules:
- "value" must be ONLY a number. No ranges, no units in value.
- "unit" must be one of: "s", "m", "m/s", "m/s^2", "cm/s^2", "No units", "km/h", "km", "min"

Return ONLY this JSON (no other text):
{"answers":[{"value":"number","unit":"unit"},...],"reasoning":"..."}

PROBLEM:
${problemText}`;
  }

  try {
    console.log("[Gemini] Sending prompt to server /gemini-web, length:", prompt.length);
    const response = await fetch('http://127.0.0.1:5000/gemini-web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    if (!response.ok) {
      const err = await response.json();
      console.log("[Gemini] Server error:", response.status, err);
      return null;
    }
    const data = await response.json();
    console.log("[Gemini] Server returned:", data.answers?.length, "answers");
    return data;
  } catch (e) {
    console.log("[Gemini] Server fetch failed:", e.message);
    return null;
  }
}

// --- Server helpers ---

async function callServerSolve(text, inputCount) {
  console.log("[Server] callServerSolve: inputCount =", inputCount);
  const response = await fetch('http://127.0.0.1:5000/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, input_count: inputCount })
  });
  if (!response.ok) {
    const err = await response.json();
    console.log("[Server] solve error:", response.status, err);
    throw new Error(err.error || `Server error ${response.status}`);
  }
  const data = await response.json();
  console.log("[Server] solve response, answers:", data.answers?.length);
  return data;
}

async function callServerRetry(text, previousAnswers, feedbackText, attempt) {
  console.log("[Server] callServerRetry: attempt =", attempt, "prevAnswers =", previousAnswers.length);
  const response = await fetch('http://127.0.0.1:5000/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_text: text, previous_answers: previousAnswers, feedback_text: feedbackText, attempt, input_count: previousAnswers.length })
  });
  if (!response.ok) {
    console.log("[Server] retry error:", response.status);
    throw new Error(`Retry error ${response.status}`);
  }
  const data = await response.json();
  console.log("[Server] retry response, answers:", data.answers?.length, "action:", data.action);
  return data;
}

async function checkServerAlive() {
  try {
    const resp = await fetch('http://127.0.0.1:5000/', { method: 'GET', signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch { return false; }
}

async function callGroqDirect(text, inputCount, retryContext) {
  let key = await new Promise(res => chrome.storage.local.get('groqKey', d => res(d.groqKey || '')));
  if (!key) { console.log("[Groq] No API key. Set via: chrome.storage.local.set({groqKey:'your_key'})"); return null; }
  console.log("[Groq] Calling Groq API directly...");
  const systemMsg = retryContext
    ? `The answers you gave were checked and some were marked incorrect. Fix only the wrong ones. Previous answers: ${JSON.stringify(retryContext.previousAnswers)}. Feedback: ${retryContext.feedbackText}. Return EXACTLY ${inputCount} answers. Return ONLY JSON: {"answers":[{"value":"number","unit":"unit"},...]}`
    : `Solve this physics problem. Return EXACTLY ${inputCount} answers. "value" must be a number only. "unit" must be one of: s, m, m/s, m/s^2, cm/s^2, No units, km/h, km, min. Return ONLY JSON: {"answers":[{"value":"number","unit":"unit"},...],"reasoning":"..."}`;
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      max_tokens: 2000
    })
  });
  if (!resp.ok) { console.log("[Groq] API error:", resp.status); return null; }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) { console.log("[Groq] No content in response"); return null; }
  console.log("[Groq] Raw response:", content.substring(0, 200));
  return extractJSON(content);
}

// --- WileyPLUS interaction helpers ---

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function scrapeFullState(tab) {
  console.log("[Scrape] scrapeFullState: tab =", tab.url);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const inputs = Array.from(document.querySelectorAll(
        'input[type="text"][aria-label="Enter your answer"], input[type="number"][aria-label="Enter your answer"]'
      ));
      const states = inputs.map(inp => ({
        value: inp.value,
        invalid: inp.getAttribute('aria-invalid') === 'true'
      }));
      let text = '';
      let isolatedCount = 0;

      const firstEmpty = inputs.find(inp => inp.value.trim() === '');
      if (firstEmpty) {
        let el = firstEmpty.closest('.question-content, .problem-statement, section.question, .assessment-question, [class*="question"], [class*="problem"]');
        if (!el) {
          el = firstEmpty.parentElement;
          for (let i = 0; i < 20 && el && el !== document.body; i++) {
            if (el.tagName === 'SECTION' || el.tagName === 'ARTICLE' ||
                (el.classList.length > 0 && Array.from(el.classList).some(c => c.includes('question') || c.includes('problem')))) {
              break;
            }
            el = el.parentElement;
          }
        }
        if (el && el !== document.body && el !== document.documentElement) {
          const clone = el.cloneNode(true);
          clone.querySelectorAll('script, style, nav, header, footer, .navigation, .sidebar').forEach(e => e.remove());
          text = clone.innerText;
          isolatedCount = el.querySelectorAll('input[aria-label="Enter your answer"]').length;
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

function cleanAnswersExtension(answers) {
  return answers.map(a => {
    let val = String(a.value || '').trim();
    const unit = String(a.unit || 'No units').trim();
    // Strip leading +
    if (val.startsWith('+')) val = val.slice(1);
    // Handle ranges "45.0 to 55.0" → average
    if (/to|–|-/.test(val)) {
      const parts = val.match(/[\d.]+/g);
      if (parts && parts.length >= 2) {
        val = String((parseFloat(parts[0]) + parseFloat(parts[1])) / 2);
      }
    }
    // Extract first number from mixed text like "3.00 m/s"
    const firstNum = val.match(/[\d.]+/);
    if (firstNum) val = firstNum[0];
    // Fallback to empty if not numeric
    if (isNaN(parseFloat(val))) val = '';
    return { value: val, unit: unit, correct: a.correct };
  });
}

function validateAnswers(answers) {
  answers.forEach((a, i) => {
    const val = String(a.value).trim();
    if (val === '' || isNaN(parseFloat(val))) {
      throw new Error(`Answer ${i+1}: "${a.value}" is not a valid number`);
    }
    a.value = val;
  });
}

function safeStorageSet(obj) {
  try { if (chrome?.storage?.local) chrome.storage.local.set(obj); } catch(e) { console.warn("[Storage] set failed:", e); }
}

function safeStorageGet(keys, cb) {
  try { if (chrome?.storage?.local) chrome.storage.local.get(keys, cb); else cb({}); } catch(e) { console.warn("[Storage] get failed:", e); cb({}); }
}

async function fillAnswers(tab, answers) {
  console.log("[Wiley] fillAnswers:", answers.length, "answers");
  console.log("[Wiley] Answers:", JSON.stringify(answers));
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (ans) => {
      const numberInputs = Array.from(document.querySelectorAll(
        'input[type="text"][aria-label="Enter your answer"], input[type="number"][aria-label="Enter your answer"]'
      ));
      const unitSelects = Array.from(document.querySelectorAll(
        'select[aria-label="Select your answer"]'
      ));
      console.log("[Wiley] fill found", numberInputs.length, "inputs,", unitSelects.length, "selects");
      ans.forEach((a, i) => {
        if (numberInputs[i] && a.correct !== true) {
          numberInputs[i].value = a.value;
          numberInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          numberInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (unitSelects[i] && a.correct !== true) {
          const opt = Array.from(unitSelects[i].options).find(o =>
            o.textContent.trim().toLowerCase() === a.unit.toLowerCase()
          );
          if (opt) {
            unitSelects[i].value = opt.value;
            unitSelects[i].dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            console.log("[Wiley] No unit option found for:", a.unit, "in select", i);
          }
        }
      });
    },
    args: [answers]
  });
}

async function checkInputsFilled(tab) {
  console.log("[Wiley] checkInputsFilled...");
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const inputs = document.querySelectorAll('input[aria-label="Enter your answer"]');
      const values = Array.from(inputs).map(inp => inp.value);
      const allFilled = values.every(v => v.trim() !== '');
      console.log("[Wiley] Input values:", JSON.stringify(values), "allFilled:", allFilled);
      return allFilled;
    }
  });
  const result = r.some(rr => rr.result === true);
  console.log("[Wiley] checkInputsFilled result:", result);
  return result;
}

async function clickSubmit(tab) {
  console.log("[Wiley] clickSubmit...");
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const selectors = [
        'button.btn.btn-primary.was-submit-answer.m-l-h',
        'button.was-submit-answer',
        'button.btn-primary.was-submit-answer',
        'button[data-testid="submit-answer"]',
        'button[aria-label="Submit Answer"]',
        'button[aria-label="Submit"]',
        '.was-submit-answer',
        'button.btn-primary[type="submit"]',
        'input[type="submit"].btn-primary',
        'button:has-text("Submit Answer")',
        'button:has-text("Submit")'
      ];
      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) {
            console.log("[Wiley] Submit button found via:", sel, "text:", btn.innerText?.trim());
            btn.click();
            return { success: true, selector: sel };
          }
        } catch {}
      }
      console.log("[Wiley] Submit button NOT found with any selector");
      return { success: false };
    }
  });
  const clicked = r.some(rr => rr.result?.success === true);
  console.log("[Wiley] clickSubmit result:", clicked);
  return r;
}

async function clickSubmitFallback(tab) {
  console.log("[Wiley] clickSubmitFallback: trying alternative selectors...");
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const selectors = [
        'button.was-submit-answer:not(.btn-primary)',
        'button.btn-primary:not(.was-submit-answer)',
        'button[type="submit"]',
        'input[type="submit"]',
        '[role="button"][aria-label*="Submit"]',
        'button:has-text("Submit")',
        '.submit-button',
        'button.MuiButton-root[type="submit"]'
      ];
      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) {
            console.log("[Wiley] Fallback found via:", sel, "text:", btn.innerText?.trim());
            btn.click();
            return true;
          }
        } catch {}
      }
      console.log("[Wiley] All fallback selectors failed");
      return false;
    }
  });
  return r.some(rr => rr.result === true);
}

async function clickNext(tab) {
  console.log("[Wiley] clickNext...");
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
        'button[title*="Next"]',
        'a[title="Next question"]',
        '[data-testid="next"]'
      ];
      for (const sel of selectors) {
        try {
          let btn = document.querySelector(sel);
          if (!btn && sel.startsWith('path[')) {
            const path = document.querySelector(sel);
            if (path) btn = path.closest('button, a, [role="button"]');
          }
          if (btn && btn.offsetParent !== null) {
            console.log("[Wiley] Next button found via:", sel);
            btn.click();
            return { success: true, selector: sel };
          }
        } catch {}
      }
      console.log("[Wiley] Next button NOT found with any selector");
      return { success: false };
    }
  });
  const result = r.some(rr => rr.result?.success === true);
  console.log("[Wiley] clickNext result:", result);
  return r;
}

async function autoDebugPage(tab) {
  console.log("[AutoDebug] Running backend page inspection...");
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const inputs = Array.from(document.querySelectorAll('input[aria-label="Enter your answer"], textarea[aria-label="Enter your answer"]')).map((inp, i) => ({
        index: i, tag: inp.tagName, type: inp.type, ariaLabel: inp.getAttribute('aria-label'),
        value: inp.value, classes: inp.className, id: inp.id,
        selector: inp.tagName.toLowerCase() + '[aria-label="Enter your answer"]'
      }));
      const submitBtns = Array.from(document.querySelectorAll('button, input[type="submit"]')).map((btn, i) => ({
        index: i, tag: btn.tagName, text: btn.innerText?.trim(), classes: btn.className, id: btn.id,
        ariaLabel: btn.getAttribute('aria-label'), visible: btn.offsetParent !== null
      }));
      return { inputs, submitBtns };
    }
  });
  const data = r[0]?.result;
  if (data) {
    console.log("[AutoDebug] DIAGNOSTICS GENERATED:", data);
    safeStorageSet({ lastAutoDebug: { timestamp: new Date().toLocaleTimeString(), data } });
  }
}

async function handleSuccess(answers, status, resultDiv, wileyTab) {
  console.log("[Wiley] handleSuccess:", answers.length, "answers, all correct");
  const text = answers.map(a => `${a.value} ${a.unit}`).join('\n');
  status.innerText = "All correct!";
  resultDiv.innerText = text;
  resultDiv.style.display = "block";
  safeStorageSet({ lastResult: { text, timestamp: new Date().toLocaleTimeString() } });
  if (autoNextEnabled) {
    console.log("[Wiley] Auto-next enabled, clicking next...");
    status.innerText = "All correct! Moving to next...";
    resultDiv.innerText = text + "\n\n[Auto-next: clicking next...]";
    await sleep(1500);
    const nextResult = await clickNext(wileyTab);
    const clicked = nextResult.some(r => r.result === "next_clicked");
    if (clicked) {
      console.log("[Wiley] Auto-next succeeded");
      status.innerText = "Moved to next question.";
      resultDiv.innerText = text + "\n\n[Auto-next: moved to next question]";
    } else {
      console.log("[Wiley] Auto-next: button not found");
      resultDiv.innerText = text + "\n\n[Auto-next: next button not found]";
    }
  }
}

async function getWileyTab() {
  console.log("[Wiley] getWileyTab: searching for WileyPLUS tab...");
  const patterns = ['*://*.wiley.com/*', '*://*.wileyplus.com/*', '*://*.wileyplus.knowmia.com/*'];
  for (const p of patterns) {
    const tabs = await chrome.tabs.query({ url: p });
    if (tabs.length > 0) {
      console.log("[Wiley] Found tab via pattern", p, ":", tabs[0].url);
      return tabs[0];
    }
  }
  // Fallback: use active tab but reject if it's gemini
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && !tab.url.includes('gemini.google.com')) {
    console.log("[Wiley] Using active tab:", tab.url);
    return tab;
  }
  console.log("[Wiley] No WileyPLUS tab found, returning active tab anyway");
  return tab;
}

// --- MAIN SOLVE FLOW ---

async function solve() {
  const status = document.getElementById('status');
  const btn = document.getElementById('solveBtn');
  const resultDiv = document.getElementById('result');

  btn.disabled = true;
  resultDiv.style.display = "none";

  try {
    const tab = await getWileyTab();
    if (!tab) {
      console.log("[Solve] No Wiley tab found");
      throw new Error("No WileyPLUS tab open. Open a WileyPLUS problem first.");
    }
    status.innerText = "Scraping...";
    console.log("[Solve] Scraping tab:", tab.url);
    const state = await scrapeFullState(tab);
    console.log("[Solve] Scraped: text length =", state.text.length, "inputCount =", state.inputCount, "inputStates =", state.inputStates.length);
    if (!state.text || state.text.trim().length === 0) {
      throw new Error("Could not find any text on the page.");
    }

    // --- Get answers: try Gemini web first, fallback to Groq direct or server ---
    status.innerText = "Asking Gemini (web)...";
    console.log("[Solve] Calling Gemini web...");
    let data = await callGeminiWeb(state.text, state.inputCount, undefined, tab.id);
    let usedGemini = !!data;
    console.log("[Solve] Gemini web returned:", usedGemini ? "answers:" + data.answers.length : "null");

    if (!data || !data.answers) {
      console.log("[Solve] Gemini unavailable, trying direct Groq...");
      status.innerText = "Gemini unavailable, using Groq...";
      data = await callGroqDirect(state.text, state.inputCount);
      usedGemini = false;
    }

    if (!data || !data.answers) {
      const serverAlive = await checkServerAlive();
      if (serverAlive) {
        status.innerText = "Groq unavailable, using server...";
        console.log("[Solve] Falling back to server...");
        data = await callServerSolve(state.text, state.inputCount);
        console.log("[Solve] Server returned:", data ? "answers:" + data.answers.length : "null");
      } else {
        console.log("[Solve] Server not running, cannot fall back");
        status.innerText = "Server not running! Click 'Start Server'.";
      }
    } else {
      status.innerText = "Gemini answered. Filling...";
    }

    if (!data || !data.answers) throw new Error("AI returned no answers");
    console.log("[Solve] Cleaning and validating answers...");
    data.answers = cleanAnswersExtension(data.answers);
    validateAnswers(data.answers);
    console.log("[Solve] Answers cleaned:", data.answers.length);

    await fillAnswers(tab, data.answers);
    console.log("[Solve] Answers filled");

    // Pre-submit validation — retry fill up to 3 times if inputs are empty
    let filled = false;
    for (let fillAttempt = 0; fillAttempt < 3; fillAttempt++) {
      if (fillAttempt > 0) {
        console.log("[Solve] Re-filling attempt", fillAttempt + 1);
        await fillAnswers(tab, data.answers);
        await sleep(1000);
      }
      filled = await checkInputsFilled(tab);
      console.log("[Solve] Pre-submit fill check:", filled ? "all filled" : "some empty");
      if (filled) break;
    }
    if (!filled) {
      status.innerText = "Some inputs empty after 3 attempts, retrying via AI...";
      console.log("[Solve] Inputs still empty after 3 retries, fall through to retry");
    } else {
      status.innerText = "Submitting...";
      console.log("[Solve] Clicking submit...");
      const submitResult = await clickSubmit(tab);
      const submitClicked = submitResult.some(r => r.result === true);
      console.log("[Solve] Submit clicked:", submitClicked);
      if (!submitClicked) {
        // Try fallback submit selectors
        const fbResult = await clickSubmitFallback(tab);
        console.log("[Solve] Fallback submit result:", fbResult);
        // Auto-debug on submit failure
        if (!fbResult) {
          console.warn("[Solve] All submit buttons failed, triggering auto-debug...");
          await autoDebugPage(tab);
        }
      }
      await sleep(7000);
    }

    let postState = await scrapeFullState(tab);
    console.log("[Solve] Post-submit state: inputStates =", postState.inputStates.length);
    while (data.answers.length < postState.inputStates.length) {
      data.answers.push({ value: '', unit: 'No units' });
    }
    let currentAnswers = postState.inputStates.map((s, i) => ({
      ...data.answers[i],
      correct: !s.invalid && s.value !== ''
    }));
    console.log("[Solve] Answers after submit:", currentAnswers.map(a => a.value + "[" + (a.correct ? "OK" : "WRONG") + "]"));

    let hadErrors = currentAnswers.some(a => a.correct === false);
    if (!hadErrors) {
      console.log("[Solve] All correct!");
      await handleSuccess(currentAnswers, status, resultDiv, tab);
      return;
    }
    console.log("[Solve] Had errors, entering retry loop");

    // --- Retry loop ---
    for (let attempt = 1; attempt <= 3; attempt++) {
      status.innerText = `Retry ${attempt}: fixing wrong answers...`;
      console.log("[Solve] Retry attempt", attempt);

      let retryData;
      if (usedGemini) {
        console.log("[Solve] Retry via Gemini web...");
        retryData = await callGeminiWeb(state.text, state.inputCount, {
          previousAnswers: currentAnswers,
          feedbackText: postState.text
        }, tab.id);
        console.log("[Solve] Gemini retry returned:", retryData ? "answers:" + (retryData.answers?.length) : "null");
      }
      if (!retryData || !retryData.answers) {
        console.log("[Solve] Retry via direct Groq...");
        retryData = await callGroqDirect(state.text, state.inputCount, {
          previousAnswers: currentAnswers,
          feedbackText: postState.text
        });
      }
      if (!retryData || !retryData.answers) {
        console.log("[Solve] Retry via server...");
        retryData = await callServerRetry(state.text, currentAnswers, postState.text, attempt);
        console.log("[Solve] Server retry returned:", retryData ? "answers:" + (retryData.answers?.length) : "null");
      }

      if (!retryData || !retryData.answers) {
        console.log("[Solve] Retry returned no answers, breaking");
        break;
      }
      retryData.answers = cleanAnswersExtension(retryData.answers);
      if (retryData.action === 'done' || currentAnswers.every(a => a.correct === true)) {
        console.log("[Solve] Retry done action or all correct");
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

      console.log("[Solve] Filling retry answers...");
      await fillAnswers(tab, currentAnswers);
      const filledRetry = await checkInputsFilled(tab);
      console.log("[Solve] Retry fill check:", filledRetry ? "all filled" : "some empty");
      if (!filledRetry) {
        status.innerText = `Retry ${attempt}: inputs still empty, re-asking...`;
        continue;
      }
      console.log("[Solve] Clicking submit (retry)...");
      let retrySubmitResult = await clickSubmit(tab);
      if (!retrySubmitResult.some(r => r.result === true)) {
        retrySubmitResult = await clickSubmitFallback(tab);
        if (!retrySubmitResult) {
          console.warn("[Solve] Retry submit failed, triggering auto-debug...");
          await autoDebugPage(tab);
        }
      }
      await sleep(7000);

      postState = await scrapeFullState(tab);
      console.log("[Solve] Post-retry state:", postState.inputStates.length, "inputs");
      while (currentAnswers.length < postState.inputStates.length) {
        currentAnswers.push({ value: '', unit: 'No units', correct: false });
      }
      currentAnswers = postState.inputStates.map((s, i) => ({
        ...currentAnswers[i],
        correct: !s.invalid && s.value !== ''
      }));
      console.log("[Solve] Retry result:", currentAnswers.map(a => a.value + "[" + (a.correct ? "OK" : "WRONG") + "]"));

      const stillWrong = currentAnswers.some(a => a.correct === false);
      if (!stillWrong) {
        console.log("[Solve] All correct after retry!");
        await handleSuccess(currentAnswers, status, resultDiv, tab);
        return;
      }
      console.log("[Solve] Still wrong after retry", attempt);
    }

    status.innerText = "Some still wrong.";
    console.log("[Solve] Final state:", currentAnswers.map(a => a.value + " " + a.unit + " [" + (a.correct ? "OK" : "WRONG") + "]"));
    resultDiv.innerText = "Final status:\n" +
      currentAnswers.map(a => `${a.value} ${a.unit} [${a.correct ? 'OK' : 'WRONG'}]`).join('\n') +
      "\n\nCheck manually.";
    resultDiv.style.display = "block";
    safeStorageSet({ lastResult: { text: resultDiv.innerText, timestamp: new Date().toLocaleTimeString() } });

  } catch (e) {
    console.log("[Solve] ERROR:", e.message, e.stack);
    status.innerText = "Error";
    resultDiv.innerText = e.message + "\n\n[Open popup console: right-click → Inspect]";
    resultDiv.style.display = "block";
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

// --- Popup setup ---

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('autoNextToggle');
  const serverDot = document.getElementById('serverDot');
  const serverLabel = document.getElementById('serverLabel');
  safeStorageGet(['lastResult', 'autoNext'], d => {
    if (d.autoNext !== undefined) {
      autoNextEnabled = d.autoNext;
      toggle.checked = d.autoNext;
    }
    if (d.lastResult) {
      document.getElementById('status').innerText = `Last (${d.lastResult.timestamp})`;
      document.getElementById('result').innerText = d.lastResult.text;
      document.getElementById('result').style.display = 'block';
    }
  });
  toggle.addEventListener('change', () => {
    autoNextEnabled = toggle.checked;
    safeStorageSet({ autoNext: toggle.checked });
  });
  checkServerAlive().then(alive => {
    serverDot.className = 'dot ' + (alive ? 'green' : 'red');
    serverLabel.textContent = alive ? 'Server: running' : 'Server: offline (using Groq direct)';
  });
});

// Debug function to inspect page selectors
async function debugPage() {
  const status = document.getElementById('status');
  const resultDiv = document.getElementById('result');
  const tab = await getWileyTab();
  if (!tab) { status.innerText = "No Wiley tab"; return; }
  
  status.innerText = "Inspecting page...";
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const inputs = Array.from(document.querySelectorAll('input[aria-label="Enter your answer"], textarea[aria-label="Enter your answer"]')).map((inp, i) => ({
        index: i, tag: inp.tagName, type: inp.type, ariaLabel: inp.getAttribute('aria-label'),
        value: inp.value, classes: inp.className, id: inp.id, selector: inp.tagName.toLowerCase() + '[aria-label="Enter your answer"]'
      }));
      const selects = Array.from(document.querySelectorAll('select[aria-label="Select your answer"]')).map((sel, i) => ({
        index: i, ariaLabel: sel.getAttribute('aria-label'), options: Array.from(sel.options).map(o => o.textContent.trim()),
        classes: sel.className, id: sel.id
      }));
      const submitBtns = Array.from(document.querySelectorAll('button, input[type="submit"]')).map((btn, i) => ({
        index: i, tag: btn.tagName, type: btn.type, text: btn.innerText?.trim(), classes: btn.className, id: btn.id,
        ariaLabel: btn.getAttribute('aria-label'), title: btn.title, testid: btn.getAttribute('data-testid'),
        visible: btn.offsetParent !== null, selector: btn.tagName.toLowerCase() + (btn.id ? '#' + btn.id : '') + (btn.className ? '.' + btn.className.split(' ').join('.') : '')
      }));
      const nextBtns = Array.from(document.querySelectorAll('button, a')).filter(el => 
        el.title?.includes('Next') || el.getAttribute('aria-label')?.includes('Next') || 
        el.innerText?.includes('Next') || el.getAttribute('data-testid')?.includes('next')
      ).map((btn, i) => ({
        index: i, tag: btn.tagName, text: btn.innerText?.trim(), classes: btn.className, id: btn.id,
        title: btn.title, ariaLabel: btn.getAttribute('aria-label'), testid: btn.getAttribute('data-testid'),
        visible: btn.offsetParent !== null
      }));
      return { inputs, selects, submitBtns, nextBtns };
    }
  });
  const data = r[0]?.result;
  if (data) {
    console.log("[Debug] Inputs:", data.inputs);
    console.log("[Debug] Selects:", data.selects);
    console.log("[Debug] Submit buttons:", data.submitBtns);
    console.log("[Debug] Next buttons:", data.nextBtns);
    resultDiv.innerText = "INPUTS:\n" + JSON.stringify(data.inputs, null, 2) +
      "\n\nSELECTS:\n" + JSON.stringify(data.selects, null, 2) +
      "\n\nSUBMIT BUTTONS:\n" + JSON.stringify(data.submitBtns, null, 2) +
      "\n\nNEXT BUTTONS:\n" + JSON.stringify(data.nextBtns, null, 2);
    resultDiv.style.display = 'block';
    status.innerText = "Debug complete - check console & result";
  } else {
    status.innerText = "Debug failed - no data returned";
  }
}

document.getElementById('solveBtn').addEventListener('click', solve);
document.getElementById('debugBtn').addEventListener('click', debugPage);
