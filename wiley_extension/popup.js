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

// --- Deep DOM Diagnostics Scraper ---
async function getAdvancedDiagnostics(tab) {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const headSummary = {
        scripts: Array.from(document.querySelectorAll('script[src]'))
          .map(s => s.src.split('/').pop())
          .filter(s => s.includes('was') || s.includes('ui') || s.includes('react') || s.includes('bundle')),
        styles: Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
          .map(l => l.href.split('/').pop())
          .filter(h => h.includes('was') || h.includes('ui') || h.includes('main')),
        meta: Array.from(document.querySelectorAll('meta[name]')).map(m => m.name).slice(0, 5)
      };

      const inputs = Array.from(document.querySelectorAll('input, select, textarea')).map(inp => {
        const parent = inp.parentElement;
        return {
          tag: inp.tagName,
          type: inp.type,
          classes: inp.className,
          hidden: inp.hidden || inp.style.display === 'none' || inp.style.visibility === 'hidden' || inp.type === 'hidden',
          disabled: inp.disabled,
          readOnly: inp.readOnly,
          value: inp.value,
          parentClasses: parent ? parent.className : ''
        };
      });

      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]')).map(btn => ({
        text: btn.innerText?.trim()?.substring(0, 30) || btn.value,
        classes: btn.className,
        disabled: btn.disabled,
        visible: btn.offsetParent !== null
      }));

      return { headSummary, inputs, buttons };
    }
  });
  return r[0]?.result || null;
}

// --- Scraper & Fill Logic ---
async function scrapeFullState(tab) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      // 1. SMART ATTEMPT TRACKER
      let attemptsUsed = 0;
      let attemptsTotal = 3; // Default safe fallback
      const bodyText = document.body.innerText.replace(/\n/g, ' ');

      // Matches "Attempts: 1 of 5 used", "Used: 1/5", etc.
      const match1 = bodyText.match(/(?:attempts?|used)[^\d]*(\d+)\s*(?:of|\/)\s*(\d+)/i);
      // Matches "1 of 5 attempts used"
      const match2 = bodyText.match(/(\d+)\s*(?:of|\/)\s*(\d+)[^\d]*(?:attempts?|used)/i);
      const attemptMatch = match1 || match2;

      if (attemptMatch) {
        attemptsUsed = parseInt(attemptMatch[1], 10);
        attemptsTotal = parseInt(attemptMatch[2], 10);
      }

      // 2. INPUT SCRAPING
      const inputs = Array.from(document.querySelectorAll('input[type="text"]:not([readonly]):not([hidden]), input[type="number"]:not([readonly]):not([hidden])'))
        .filter(inp => !inp.id.toLowerCase().includes('search') && !inp.className.toLowerCase().includes('search'));

      const selects = Array.from(document.querySelectorAll('select'));
      const selectOptions = selects.map(sel =>
        Array.from(sel.options)
          .map(o => o.textContent.trim())
          .filter(t => t && t.toLowerCase() !== 'select an option' && t !== '---' && t !== '')
      );

      // 3. SMART DOM INSPECTION (Correct/Incorrect indicators)
      const states = inputs.map(inp => {
        const parent = inp.closest('label, div, td, tr, .question-content');
        const html = parent ? parent.innerHTML.toLowerCase() : inp.outerHTML.toLowerCase();

        const invalidAttr = inp.getAttribute('aria-invalid') === 'true';
        const hasWrongIcon = html.includes('fa-times') || html.includes('incorrect') || html.includes('wrong') || html.includes('error');
        const classInvalid = /invalid|incorrect|wrong|error/i.test(inp.className) || (parent && /invalid|incorrect|wrong|error/i.test(parent.className));

        const hasCorrectIcon = html.includes('fa-check') || html.includes('correct') || html.includes('right');
        const classCorrect = /correct|valid|success/i.test(inp.className) || (parent && /correct|valid|success/i.test(parent.className));

        const isActuallyWrong = (invalidAttr || classInvalid || hasWrongIcon) && !html.includes('partially correct');
        const isActuallyRight = (hasCorrectIcon || classCorrect) && !isActuallyWrong;

        return {
          value: inp.value,
          invalid: isActuallyWrong,
          isCorrect: isActuallyRight
        };
      });

      // 4. TEXT EXTRACTION
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

      return JSON.stringify({
          text,
          inputStates: states,
          inputCount: isolatedCount || inputs.length,
          unitOptions: selectOptions,
          attemptsUsed,
          attemptsTotal
      });
    }
  });

  const parsed = results.map(r => JSON.parse(r.result));

  // Resolve cross-frame attempts
  let finalAttemptsUsed = 0;
  let finalAttemptsTotal = 3;
  parsed.forEach(p => {
      if (p.attemptsTotal > 0 && p.attemptsTotal !== 3 || p.attemptsUsed > 0) {
          finalAttemptsUsed = Math.max(finalAttemptsUsed, p.attemptsUsed);
          finalAttemptsTotal = Math.max(finalAttemptsTotal, p.attemptsTotal);
      }
  });

  return {
    text: parsed.map(p => p.text).filter(t => t).join("\n\n--- Frame Boundary ---\n\n"),
    inputStates: parsed.flatMap(p => p.inputStates),
    inputCount: Math.max(...parsed.filter(p => p.text).map(p => p.inputCount), 0),
    unitOptions: parsed.flatMap(p => p.unitOptions),
    attemptsUsed: finalAttemptsUsed,
    attemptsTotal: finalAttemptsTotal
  };
}

async function fillAnswers(tab, answers) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (ans) => {
      const numberInputs = Array.from(document.querySelectorAll('input[type="text"]:not([readonly]):not([hidden]), input[type="number"]:not([readonly]):not([hidden])'))
        .filter(inp => !inp.id.toLowerCase().includes('search') && !inp.className.toLowerCase().includes('search'));
      const unitSelects = Array.from(document.querySelectorAll('select'));

      ans.forEach((a, i) => {
        let safeVal = String(a.value || '').trim();
        if (safeVal.toLowerCase() === 'undefined' || safeVal.toLowerCase() === 'null') safeVal = '';

        if (numberInputs[i] && a.correct !== true && safeVal !== '') {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          if (nativeInputValueSetter) nativeInputValueSetter.call(numberInputs[i], safeVal);
          else numberInputs[i].value = safeVal;

          numberInputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          numberInputs[i].dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (unitSelects[i] && a.correct !== true && a.unit) {
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

async function callServerRetry(text, previousAnswers, feedbackText, attempt, inputCount, unitOptions, diagnostics = null) {
  const response = await fetch('http://127.0.0.1:5000/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_text: text, previous_answers: previousAnswers, feedback_text: feedbackText, attempt, input_count: inputCount, unit_options: unitOptions, diagnostics })
  });
  if (!response.ok) throw new Error(`Retry error ${response.status}`);
  return await response.json();
}

// --- Helper Functions ---
function cleanAnswersExtension(answers) {
  return answers.map(a => {
    if (!a) return { value: '', unit: 'No units', correct: false };
    let val = String(a.value || '').trim();
    if (val.toLowerCase() === 'undefined' || val.toLowerCase() === 'null') val = '';

    if (val.startsWith('+')) val = val.slice(1);
    if (/to|–|-/.test(val) && !val.startsWith('-')) {
      const parts = val.match(/[\d.]+/g);
      if (parts && parts.length >= 2) val = String((parseFloat(parts[0]) + parseFloat(parts[1])) / 2);
    }
    const firstNum = val.match(/-?[\d.]+/);
    if (firstNum) val = firstNum[0];
    if (isNaN(parseFloat(val))) val = '';

    return { value: val, unit: a.unit || 'No units', correct: a.correct };
  });
}

function validateAnswers(answers, expectedCount) {
  if (answers.length !== expectedCount) {
      throw new Error(`Alignment Error: AI returned ${answers.length} answers, but page requires ${expectedCount}. Aborting to prevent bad fill.`);
  }
  answers.forEach((a, i) => {
    const val = String(a.value).trim();
    if (val === '' || isNaN(parseFloat(val))) throw new Error(`Answer ${i+1} is missing or not a valid number.`);
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

// --- Submit & Verify Logic ---
async function verifyAllFilled(tab) {
  const state = await scrapeFullState(tab);
  const emptyCount = state.inputStates.filter(s => s.value.trim() === '').length;
  return emptyCount === 0;
}

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
  let lastDiagnosticAlert = null;

  try {
    const tab = await getWileyTab();
    if (!tab) throw new Error("No WileyPLUS tab open.");

    status.innerText = "Scraping...";
    const state = await scrapeFullState(tab);

    if (state.inputCount === 0) {
      throw new Error("Could not find any text inputs.");
    }

    // SAFETY BLOCK: Max attempts already reached before we even start
    if (state.attemptsUsed >= state.attemptsTotal && state.attemptsTotal > 0) {
        throw new Error(`Safety Abort: ${state.attemptsUsed}/${state.attemptsTotal} attempts used. You are out of attempts!`);
    }

    status.innerText = `Attempts Left: ${state.attemptsTotal - state.attemptsUsed}. Asking Server...`;
    let data = await callServerSolve(state.text, state.inputCount, state.unitOptions);

    if (!data || !data.answers) throw new Error("Server returned no answers");

    data.answers = cleanAnswersExtension(data.answers);
    validateAnswers(data.answers, state.inputCount);

    status.innerText = "Filling answers...";
    await fillAnswers(tab, data.answers);

    status.innerText = "Verifying inputs...";
    if (!(await verifyAllFilled(tab))) {
        throw new Error("Safety Abort: Some inputs are still blank. Submit aborted to save your attempt.");
    }

    status.innerText = "Submitting...";
    await clickSubmit(tab);
    await sleep(7000);

    // POST-SUBMIT VERIFICATION & RETRY LOGIC
    let postState = await scrapeFullState(tab);

    let currentAnswers = postState.inputStates.map((s, i) => {
        let correctStatus = false;
        if (s.isCorrect) correctStatus = true;
        else if (s.invalid) correctStatus = false;
        else correctStatus = (s.value !== '');

        return {
            value: s.value,
            unit: data.answers[i]?.unit || 'No units',
            correct: correctStatus,
            isNeutral: !s.isCorrect && !s.invalid
        };
    });

    const lowerText = postState.text.toLowerCase();
    const hasGlobalError = lowerText.includes("partially correct") || lowerText.includes("incorrect");

    if (hasGlobalError) {
        currentAnswers.forEach(a => {
            if (a.isNeutral) a.correct = false;
        });
    }

    let hadErrors = currentAnswers.some(a => a.correct === false);
    if (!hadErrors) {
      await handleSuccess(currentAnswers, status, resultDiv);
      return;
    }

    // CALCULATE REMAINING RETRIES
    let retriesAllowed = postState.attemptsTotal - postState.attemptsUsed;
    if (retriesAllowed > 5) retriesAllowed = 5; // Cap to prevent runaway loops

    if (retriesAllowed <= 0) {
        status.innerText = "No attempts left.";
        resultDiv.innerText = "Final status:\n" + currentAnswers.map(a => `${a.value} ${a.unit} [${a.correct ? 'OK' : 'WRONG'}]`).join('\n') + "\n\nMaximum attempts reached.";
        resultDiv.style.display = "block";
        return;
    }

    // DYNAMIC RETRY LOOP
    for (let attempt = 1; attempt <= retriesAllowed; attempt++) {
      status.innerText = `Retry ${attempt}/${retriesAllowed}: fixing wrong answers...`;

      // Trigger diagnostics on the FINAL allowed attempt, OR on attempt 3 (whichever comes first)
      let diagnostics = null;
      const triggerDiagnostics = (attempt === retriesAllowed) || (attempt === 3);

      if (triggerDiagnostics) {
          status.innerText = `Retry ${attempt}/${retriesAllowed}: Running Deep DOM Diagnostics...`;
          diagnostics = await getAdvancedDiagnostics(tab);
      }

      let retryData = await callServerRetry(state.text, currentAnswers, postState.text, attempt, state.inputCount, state.unitOptions, diagnostics);
      if (!retryData || !retryData.answers) break;

      if (retryData.diagnostics_alert) {
          lastDiagnosticAlert = retryData.diagnostics_alert;
          console.warn("[AI DOM ANALYSIS]", lastDiagnosticAlert);
      }

      retryData.answers = cleanAnswersExtension(retryData.answers);
      if (retryData.action === 'done' || currentAnswers.every(a => a.correct === true)) {
        await handleSuccess(currentAnswers, status, resultDiv);
        return;
      }

      validateAnswers(retryData.answers, state.inputCount);

      currentAnswers = currentAnswers.map((old, i) => {
          if (old.correct === true) return old;
          const newAns = retryData.answers[i];
          if (!newAns || newAns.value === '' || newAns.value === undefined) return old;
          return { value: newAns.value, unit: newAns.unit, correct: false, isNeutral: old.isNeutral };
      });

      await fillAnswers(tab, currentAnswers);

      status.innerText = "Verifying retry inputs...";
      if (!(await verifyAllFilled(tab))) {
          throw new Error(`Safety Abort (Retry ${attempt}): AI left an input empty. Aborting submit.`);
      }

      await clickSubmit(tab);
      await sleep(7000);

      postState = await scrapeFullState(tab);
      currentAnswers = postState.inputStates.map((s, i) => {
        let correctStatus = false;
        if (s.isCorrect) correctStatus = true;
        else if (s.invalid) correctStatus = false;
        else correctStatus = (s.value !== '');

        return {
            value: s.value,
            unit: currentAnswers[i]?.unit || 'No units',
            correct: correctStatus,
            isNeutral: !s.isCorrect && !s.invalid
        };
      });

      let stillWrong = currentAnswers.some(a => a.correct === false);
      const lowerTextRetry = postState.text.toLowerCase();
      const globalErrorCheck = lowerTextRetry.includes("partially correct") || lowerTextRetry.includes("incorrect");

      if (globalErrorCheck) {
          currentAnswers.forEach(a => {
              if (a.isNeutral) {
                  a.correct = false;
                  stillWrong = true;
              }
          });
      }

      if (!stillWrong) {
        await handleSuccess(currentAnswers, status, resultDiv);
        return;
      }
    }

    status.innerText = "Some still wrong.";
    let finalOutput = "Final status:\n" + currentAnswers.map(a => `${a.value} ${a.unit} [${a.correct ? 'OK' : 'WRONG'}]`).join('\n') + "\n\nCheck manually.";

    if (lastDiagnosticAlert) {
        finalOutput = "AI SYSTEM ANALYSIS:\n" + lastDiagnosticAlert + "\n\n" + finalOutput;
    }

    resultDiv.innerText = finalOutput;
    resultDiv.style.display = "block";

  } catch (e) {
    status.innerText = "Error";
    resultDiv.innerText = e.message;
    if (lastDiagnosticAlert) {
        resultDiv.innerText = "AI SYSTEM ANALYSIS:\n" + lastDiagnosticAlert + "\n\nError: " + e.message;
    }
    resultDiv.style.display = "block";
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('solveBtn').addEventListener('click', solve);
});
