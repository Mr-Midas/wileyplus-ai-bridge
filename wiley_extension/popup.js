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
}

function clearUI() {
  for (let i = 1; i <= 6; i++) {
    const step = document.getElementById('step' + i);
    if (step) step.className = 'step';
  }
}

// --- Scraper & Fill Logic ---
async function scrapeFullState(tab) {
  console.log("[Scrape] scrapeFullState: tab =", tab.url);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      // Get Inputs (ignore search bars)
      const inputs = Array.from(document.querySelectorAll('input[type="text"]:not([readonly]):not([hidden]), input[type="number"]:not([readonly]):not([hidden])'))
        .filter(inp => !inp.id.toLowerCase().includes('search') && !inp.className.toLowerCase().includes('search'));

      // Get Dropdown Units (Removed :not([hidden]) to catch React/MUI hidden selects)
      const selects = Array.from(document.querySelectorAll('select'));
      const selectOptions = selects.map(sel =>
        Array.from(sel.options)
          .map(o => o.textContent.trim())
          .filter(t => t && t.toLowerCase() !== 'select an option' && t !== '---' && t !== '')
      );

      // Aggressively check for Wrong/Invalid Indicators
      const states = inputs.map(inp => {
        const parent = inp.closest('label, div, td, tr, .question-content');
        const invalidAttr = inp.getAttribute('aria-invalid') === 'true';

        const html = parent ? parent.innerHTML.toLowerCase() : inp.outerHTML.toLowerCase();
        const hasWrongIcon = html.includes('fa-times') || html.includes('incorrect') || html.includes('wrong') || html.includes('error');
        const classInvalid = /invalid|incorrect|wrong|error/i.test(inp.className) || (parent && /invalid|incorrect|wrong|error/i.test(parent.className));

        return {
          value: inp.value,
          invalid: invalidAttr || classInvalid || hasWrongIcon
        };
      });

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
      return JSON.stringify({ text, inputStates: states, inputCount: isolatedCount || inputs.length, unitOptions: selectOptions });
    }
  });
  const parsed = results.map(r => JSON.parse(r.result));
  return {
    text: parsed.map(p => p.text).filter(t => t).join("\n\n--- Frame Boundary ---\n\n"),
    inputStates: parsed.flatMap(p => p.inputStates),
    inputCount: Math.max(...parsed.filter(p => p.text).map(p => p.inputCount), 0),
    unitOptions: parsed.flatMap(p => p.unitOptions)
  };
}

async function fillAnswers(tab, answers) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (ans) => {
      const numberInputs = Array.from(document.querySelectorAll('input[type="text"]:not([readonly]):not([hidden]), input[type="number"]:not([readonly]):not([hidden])'))
        .filter(inp => !inp.id.toLowerCase().includes('search') && !inp.className.toLowerCase().includes('search'));
      const unitSelects = Array.from(document.querySelectorAll('select')); // Catch hidden selects

      ans.forEach((a, i) => {
        // Fill Text/Number Value
        if (numberInputs[i] && a.correct !== true) {
          // React Native Value Setter bypass
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          if (nativeInputValueSetter) nativeInputValueSetter.call(numberInputs[i], a.value);
          else numberInputs[i].value = a.value;

          numberInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          numberInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Fill Dropdown Unit
        if (unitSelects[i] && a.correct !== true) {
          const opt = Array.from(unitSelects[i].options).find(o => o.textContent.trim().toLowerCase() === String(a.unit).trim().toLowerCase());
          if (opt) {
            const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
            if (nativeSelectValueSetter) nativeSelectValueSetter.call(unitSelects[i], opt.value);
            else unitSelects[i].value = opt.value;

            unitSelects[i].dispatchEvent(new Event('change', { bubbles: true }));
            unitSelects[i].dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      });
    },
    args: [answers]
  });
}

// --- Server & API Calls ---
async function callServerSolve(text, inputCount, unitOptions) {
  const response = await fetch('http://127.0.0.1:5000/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, input_count: inputCount, unit_options: unitOptions })
  });
  if (!response.ok) throw new Error(`Server error ${response.status}`);
  return await response.json();
}

async function callServerRetry(text, previousAnswers, feedbackText, attempt, inputCount, unitOptions) {
  const response = await fetch('http://127.0.0.1:5000/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_text: text, previous_answers: previousAnswers, feedback_text: feedbackText, attempt, input_count: inputCount, unit_options: unitOptions })
  });
  if (!response.ok) throw new Error(`Retry error ${response.status}`);
  return await response.json();
}

// --- Helper Functions ---
function cleanAnswersExtension(answers) {
  return answers.map(a => {
    let val = String(a.value || '').trim();
    if (val.startsWith('+')) val = val.slice(1);
    if (/to|–|-/.test(val)) {
      const parts = val.match(/[\d.]+/g);
      if (parts && parts.length >= 2) val = String((parseFloat(parts[0]) + parseFloat(parts[1])) / 2);
    }
    const firstNum = val.match(/[\d.]+/);
    if (firstNum) val = firstNum[0];
    if (isNaN(parseFloat(val))) val = '';
    return { value: val, unit: a.unit, correct: a.correct };
  });
}

function validateAnswers(answers) {
  answers.forEach((a, i) => {
    const val = String(a.value).trim();
    if (val === '' || isNaN(parseFloat(val))) throw new Error(`Answer ${i+1}: "${a.value}" is not a valid number`);
    a.value = val;
  });
}

async function getWileyTab() {
  const patterns = ['*://*.wiley.com/*', '*://*.wileyplus.com/*', '*://*.wileyplus.knowmia.com/*'];
  for (const p of patterns) {
    const tabs = await chrome.tabs.query({ url: p });
    if (tabs.length > 0) return tabs[0];
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Background Diagnostics Generator ---
async function autoDebugPage(tab) {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"]')).map((inp, i) => ({
        index: i, ariaLabel: inp.getAttribute('aria-label'), value: inp.value, classes: inp.className, id: inp.id
      }));
      const submitBtns = Array.from(document.querySelectorAll('button, input[type="submit"]')).map((btn, i) => ({
        index: i, text: btn.innerText?.trim(), classes: btn.className, visible: btn.offsetParent !== null
      }));
      return { inputs, submitBtns };
    }
  });
  if (r[0]?.result) {
    chrome.storage.local.set({ lastAutoDebug: { timestamp: new Date().toLocaleTimeString(), data: r[0].result } });
  }
}

// --- Submit & Next Logic ---
async function clickSubmit(tab) {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const selectors = ['button.was-submit-answer', 'button[data-testid="submit-answer"]', 'button[aria-label*="Submit"]', '.submit-button', 'button:has-text("Submit")'];
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

async function handleSuccess(answers, status, resultDiv) {
  status.innerText = "All correct!";
  resultDiv.innerText = answers.map(a => `${a.value} ${a.unit}`).join('\n');
  resultDiv.style.display = "block";
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
    if (!tab) throw new Error("No WileyPLUS tab open.");

    status.innerText = "Scraping...";
    const state = await scrapeFullState(tab);

    if (state.inputCount === 0) {
      await autoDebugPage(tab);
      throw new Error("Could not find any text inputs. Debug data saved to background.");
    }

    status.innerText = "Asking Backend Server...";
    let data = await callServerSolve(state.text, state.inputCount, state.unitOptions);

    if (!data || !data.answers) throw new Error("Server returned no answers");

    data.answers = cleanAnswersExtension(data.answers);
    validateAnswers(data.answers);

    status.innerText = "Filling answers...";
    await fillAnswers(tab, data.answers);

    status.innerText = "Submitting...";
    const submitResult = await clickSubmit(tab);
    if (!submitResult) await autoDebugPage(tab);
    await sleep(7000);

    // ---------------------------------------------
    // POST-SUBMIT VERIFICATION & RETRY LOGIC
    // ---------------------------------------------
    let postState = await scrapeFullState(tab);
    let currentAnswers = postState.inputStates.map((s, i) => ({
      ...data.answers[i],
      correct: !s.invalid && s.value !== ''
    }));

    let hadErrors = currentAnswers.some(a => a.correct === false);

    const lowerText = postState.text.toLowerCase();
    const hasGlobalError = lowerText.includes("partially correct") || lowerText.includes("incorrect");

    if (!hadErrors && hasGlobalError) {
        console.warn("[Solve] No inputs flagged as invalid, but global error found. Forcing retry.");
        currentAnswers.forEach(a => a.correct = false);
        hadErrors = true;
    }

    if (!hadErrors) {
      await handleSuccess(currentAnswers, status, resultDiv);
      return;
    }

    // RETRY LOOP
    for (let attempt = 1; attempt <= 3; attempt++) {
      status.innerText = `Retry ${attempt}: fixing wrong answers...`;

      let retryData = await callServerRetry(state.text, currentAnswers, postState.text, attempt, state.inputCount, state.unitOptions);
      if (!retryData || !retryData.answers) break;

      retryData.answers = cleanAnswersExtension(retryData.answers);
      if (retryData.action === 'done' || currentAnswers.every(a => a.correct === true)) {
        await handleSuccess(currentAnswers, status, resultDiv);
        return;
      }
      validateAnswers(retryData.answers);

      // Merge fixes
      currentAnswers = currentAnswers.map((old, i) => old.correct === true ? old : { ...retryData.answers[i], correct: false });

      await fillAnswers(tab, currentAnswers);
      await clickSubmit(tab);
      await sleep(7000);

      postState = await scrapeFullState(tab);
      currentAnswers = postState.inputStates.map((s, i) => ({
        ...currentAnswers[i],
        correct: !s.invalid && s.value !== ''
      }));

      let stillWrong = currentAnswers.some(a => a.correct === false);
      const lowerTextRetry = postState.text.toLowerCase();
      const globalErrorCheck = lowerTextRetry.includes("partially correct") || lowerTextRetry.includes("incorrect");

      // SAFETY NET COPIED INTO RETRY LOOP
      if (!stillWrong && globalErrorCheck) {
          console.warn("[Solve] Retry Loop: Global error detected but no individual invalid inputs. Forcing retry.");
          currentAnswers.forEach(a => a.correct = false);
          stillWrong = true;
      }

      if (!stillWrong) {
        await handleSuccess(currentAnswers, status, resultDiv);
        return;
      }
    }

    status.innerText = "Some still wrong.";
    resultDiv.innerText = "Final status:\n" + currentAnswers.map(a => `${a.value} ${a.unit} [${a.correct ? 'OK' : 'WRONG'}]`).join('\n') + "\n\nCheck manually.";
    resultDiv.style.display = "block";

  } catch (e) {
    status.innerText = "Error";
    resultDiv.innerText = e.message;
    resultDiv.style.display = "block";
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('solveBtn').addEventListener('click', solve);
});
