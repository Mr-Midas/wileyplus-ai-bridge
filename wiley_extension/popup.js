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

// --- Deep DOM Diagnostics Scraper (Enhanced for React/MUI) ---
async function getAdvancedDiagnostics(tab) {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const headSummary = {
        scripts: Array.from(document.querySelectorAll('script[src]'))
          .map(s => s.src.split('/').pop())
          .filter(s => /was|ui|react|bundle|main/i.test(s)),
        frameworksDetected: {
            materialUI: !!document.querySelector('[class*="Mui"]'),
            antDesign: !!document.querySelector('[class*="ant-"]'),
            react: !!Array.from(document.querySelectorAll('*')).some(e => Object.keys(e).some(k => k.startsWith('__react')))
        }
      };

      const interactiveElements = Array.from(document.querySelectorAll('input, select, textarea, button')).map(el => {
        let labelText = '';
        const parent = el.closest('td, div, .question-content');
        if (parent) {
            const clone = parent.cloneNode(true);
            clone.querySelectorAll('input, select, textarea, button').forEach(e => e.remove());
            labelText = clone.innerText.trim().substring(0, 40);
        }

        return {
          tag: el.tagName,
          type: el.type,
          classes: el.className,
          hidden: el.hidden || el.style.display === 'none' || el.style.visibility === 'hidden' || el.type === 'hidden',
          value: el.value,
          contextLabel: labelText,
          muiControlled: Object.keys(el).some(k => k.includes('reactEventHandlers'))
        };
      });

      return { headSummary, interactiveElements };
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
      let attemptsTotal = 3; 
      const bodyText = document.body.innerText.replace(/\n/g, ' ');
      
      const match1 = bodyText.match(/(?:attempts?|used)[^\d]*(\d+)\s*(?:of|\/)\s*(\d+)/i);
      const match2 = bodyText.match(/(\d+)\s*(?:of|\/)\s*(\d+)[^\d]*(?:attempts?|used)/i);
      const attemptMatch = match1 || match2;
      
      if (attemptMatch) {
        attemptsUsed = parseInt(attemptMatch[1], 10);
        attemptsTotal = parseInt(attemptMatch[2], 10);
      }

      // 2. GROUPED DOM EXTRACTION: [Sign Dropdown] -> [Number Box] -> [Unit Dropdown]
      const elements = Array.from(document.querySelectorAll('input[type="text"]:not([readonly]):not([hidden]), input[type="number"]:not([readonly]):not([hidden]), select'))
        .filter(el => !el.id?.toLowerCase().includes('search') && !el.className.toLowerCase().includes('search'));
      
      let fields = [];
      let tempGroup = { signSelect: null, input: null, unitSelect: null };

      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        
        if (el.tagName === 'SELECT') {
            const options = Array.from(el.options).map(o => o.textContent.trim());
            const isSignDropdown = options.includes('+') || options.includes('-') || options.includes('positive');
            
            if (isSignDropdown && !tempGroup.input) {
                tempGroup.signSelect = el;
            } else if (tempGroup.input && !tempGroup.unitSelect) {
                tempGroup.unitSelect = el;
                fields.push(tempGroup);
                tempGroup = { signSelect: null, input: null, unitSelect: null };
            } else {
                if (tempGroup.input) fields.push(tempGroup);
                tempGroup = { signSelect: null, input: null, unitSelect: el };
            }
        } else if (el.tagName === 'INPUT') {
            if (tempGroup.input) {
                fields.push(tempGroup);
                tempGroup = { signSelect: null, input: el, unitSelect: null };
            } else {
                tempGroup.input = el;
            }
            
            const nextEl = elements[i+1];
            const nextIsSignSelect = nextEl?.tagName === 'SELECT' && Array.from(nextEl.options).some(o => ['+', '-'].includes(o.textContent.trim()));
            if (!nextEl || nextEl.tagName === 'INPUT' || nextIsSignSelect) {
                fields.push(tempGroup);
                tempGroup = { signSelect: null, input: null, unitSelect: null };
            }
        }
      }
      if (tempGroup.input) fields.push(tempGroup);

      // 3. SMART DOM INSPECTION (Map groups to metadata)
      const fieldData = fields.map(g => {
        const inp = g.input;
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
          isCorrect: isActuallyRight,
          hasSign: !!g.signSelect,
          signOptions: g.signSelect ? Array.from(g.signSelect.options).map(o => o.textContent.trim()).filter(t => t && t !== '---') : [],
          hasUnit: !!g.unitSelect,
          unitOptions: g.unitSelect ? Array.from(g.unitSelect.options).map(o => o.textContent.trim()).filter(t => t && t.toLowerCase() !== 'select an option' && t !== '---') : []
        };
      });
      
      // 4. TEXT EXTRACTION
      let text = '';
      const firstEmpty = fields.find(g => g.input.value.trim() === '');
      if (firstEmpty) {
        let el = firstEmpty.input.closest('.question-content, .problem-statement, section.question, .assessment-question, [class*="question"], [class*="problem"]');
        if (!el) el = firstEmpty.input.parentElement;
        if (el && el !== document.body) {
          const clone = el.cloneNode(true);
          clone.querySelectorAll('script, style, nav, header, footer, .navigation, .sidebar').forEach(e => e.remove());
          text = clone.innerText;
        }
      }
      
      if (!text) {
        const cloned = document.body.cloneNode(true);
        cloned.querySelectorAll('script, style, nav, header, footer, .navigation, .sidebar').forEach(e => e.remove());
        text = cloned.innerText;
      }
      
      return JSON.stringify({ 
          text, 
          fields: fieldData, 
          attemptsUsed,
          attemptsTotal
      });
    }
  });
  
  const parsed = results.map(r => JSON.parse(r.result));
  
  let finalAttemptsUsed = 0;
  let finalAttemptsTotal = 3;
  parsed.forEach(p => {
      if ((p.attemptsTotal > 0 && p.attemptsTotal !== 3) || p.attemptsUsed > 0) {
          finalAttemptsUsed = Math.max(finalAttemptsUsed, p.attemptsUsed);
          finalAttemptsTotal = Math.max(finalAttemptsTotal, p.attemptsTotal);
      }
  });

  return {
    text: parsed.map(p => p.text).filter(t => t).join("\n\n--- Frame Boundary ---\n\n"),
    fields: parsed.flatMap(p => p.fields),
    attemptsUsed: finalAttemptsUsed,
    attemptsTotal: finalAttemptsTotal
  };
}

async function fillAnswers(tab, answers) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (ans) => {
      function setReactValue(element, value) {
          if (!element) return;
          const isSelect = element.tagName === 'SELECT';
          const setter = Object.getOwnPropertyDescriptor(isSelect ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, "value").set;
          
          const tracker = element._valueTracker;
          if (tracker) tracker.setValue(element.value);

          if (setter) setter.call(element, value);
          else element.value = value;
          
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          element.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      const elements = Array.from(document.querySelectorAll('input[type="text"]:not([readonly]):not([hidden]), input[type="number"]:not([readonly]):not([hidden]), select'))
        .filter(el => !el.id?.toLowerCase().includes('search') && !el.className.toLowerCase().includes('search'));
      
      let fields = [];
      let tempGroup = { signSelect: null, input: null, unitSelect: null };

      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el.tagName === 'SELECT') {
            const options = Array.from(el.options).map(o => o.textContent.trim());
            if (options.includes('+') || options.includes('-')) {
                if (!tempGroup.input) tempGroup.signSelect = el;
            } else if (tempGroup.input && !tempGroup.unitSelect) {
                tempGroup.unitSelect = el;
                fields.push(tempGroup);
                tempGroup = { signSelect: null, input: null, unitSelect: null };
            } else {
                if (tempGroup.input) fields.push(tempGroup);
                tempGroup = { signSelect: null, input: null, unitSelect: el };
            }
        } else if (el.tagName === 'INPUT') {
            if (tempGroup.input) {
                fields.push(tempGroup);
                tempGroup = { signSelect: null, input: el, unitSelect: null };
            } else {
                tempGroup.input = el;
            }
            const nextEl = elements[i+1];
            const nextIsSignSelect = nextEl?.tagName === 'SELECT' && Array.from(nextEl.options).some(o => ['+', '-'].includes(o.textContent.trim()));
            if (!nextEl || nextEl.tagName === 'INPUT' || nextIsSignSelect) {
                fields.push(tempGroup);
                tempGroup = { signSelect: null, input: null, unitSelect: null };
            }
        }
      }
      if (tempGroup.input) fields.push(tempGroup);

      ans.forEach((a, i) => {
        const field = fields[i];
        if (!field) return;

        if (a.correct === true) return;

        if (field.signSelect && a.sign) {
            const opt = Array.from(field.signSelect.options).find(o => o.textContent.trim() === String(a.sign).trim() || (a.sign === '-' && o.textContent.toLowerCase().includes('negative')));
            if (opt) setReactValue(field.signSelect, opt.value);
        }

        let safeVal = String(a.value || '').trim();
        if (safeVal.toLowerCase() === 'undefined' || safeVal.toLowerCase() === 'null') safeVal = '';
        if (field.input && safeVal !== '') {
            setReactValue(field.input, safeVal);
        }
        
        if (field.unitSelect && a.unit) {
          const opt = Array.from(field.unitSelect.options).find(o => o.textContent.trim().toLowerCase() === String(a.unit).trim().toLowerCase());
          if (opt) setReactValue(field.unitSelect, opt.value);
        }
      });
    },
    args: [answers]
  });
}

// --- Server & API Calls ---
async function callServerSolve(text, fields) {
  const response = await fetch('http://127.0.0.1:5000/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, fields })
  });
  if (!response.ok) throw new Error(`Server error ${response.status}`);
  return await response.json();
}

async function callServerRetry(text, previousAnswers, feedbackText, attempt, fields, diagnostics = null) {
  const response = await fetch('http://127.0.0.1:5000/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_text: text, previous_answers: previousAnswers, feedback_text: feedbackText, attempt, fields, diagnostics })
  });
  if (!response.ok) throw new Error(`Retry error ${response.status}`);
  return await response.json();
}

// --- Helper Functions ---
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
  const emptyCount = state.fields.filter(f => f.value.trim() === '').length;
  return emptyCount === 0;
}

async function clickSubmit(tab) {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      const selectors = ['button.was-submit-answer', 'button[data-testid="submit-answer"]', 'button[aria-label*="Submit"]', '.submit-button'];
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
  resultDiv.innerText = answers.map(a => `${a.sign || ''}${a.value} ${a.unit || ''}`).join('\n');
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
    
    status.innerText = "Scraping grouped elements...";
    const state = await scrapeFullState(tab);
    
    if (state.fields.length === 0) {
      throw new Error("Could not find any text inputs.");
    }
    
    if (state.attemptsUsed >= state.attemptsTotal && state.attemptsTotal > 0) {
        throw new Error(`Safety Abort: ${state.attemptsUsed}/${state.attemptsTotal} attempts used. You are out of attempts!`);
    }

    status.innerText = `Attempts Left: ${state.attemptsTotal - state.attemptsUsed}. Asking Server...`;
    let data = await callServerSolve(state.text, state.fields);

    if (!data || !data.answers) throw new Error("Server returned no answers");
    
    validateAnswers(data.answers, state.fields.length);

    status.innerText = "Filling answers via React Injection...";
    await fillAnswers(tab, data.answers);

    status.innerText = "Verifying inputs...";
    if (!(await verifyAllFilled(tab))) {
        throw new Error("Safety Abort: React rejected the input fill. Submit aborted to save your attempt.");
    }

    status.innerText = "Submitting...";
    await clickSubmit(tab);
    await sleep(7000); 

    let postState = await scrapeFullState(tab);
    
    let currentAnswers = postState.fields.map((f, i) => {
        let correctStatus = false;
        if (f.isCorrect) correctStatus = true; 
        else if (f.invalid) correctStatus = false; 
        else correctStatus = (f.value !== ''); 

        return {
            value: f.value,
            sign: data.answers[i]?.sign || '',
            unit: data.answers[i]?.unit || '',
            correct: correctStatus,
            isNeutral: !f.isCorrect && !f.invalid
        };
    });

    const lowerText = postState.text.toLowerCase();
    const hasGlobalError = lowerText.includes("partially correct") || lowerText.includes("incorrect");
    
    if (hasGlobalError) {
        currentAnswers.forEach(a => { if (a.isNeutral) a.correct = false; });
    }

    let hadErrors = currentAnswers.some(a => a.correct === false);
    if (!hadErrors) {
      await handleSuccess(currentAnswers, status, resultDiv);
      return;
    }

    let retriesAllowed = postState.attemptsTotal - postState.attemptsUsed;
    if (retriesAllowed > 5) retriesAllowed = 5; 
    
    if (retriesAllowed <= 0) {
        status.innerText = "No attempts left.";
        resultDiv.innerText = "Final status:\n" + currentAnswers.map(a => `${a.sign || ''}${a.value} ${a.unit || ''} [${a.correct ? 'OK' : 'WRONG'}]`).join('\n') + "\n\nMaximum attempts reached.";
        resultDiv.style.display = "block";
        return;
    }

    for (let attempt = 1; attempt <= retriesAllowed; attempt++) {
      status.innerText = `Retry ${attempt}/${retriesAllowed}: fixing wrong answers...`;
      
      let diagnostics = null;
      const triggerDiagnostics = (attempt === retriesAllowed) || (attempt === 3);
      
      if (triggerDiagnostics) {
          status.innerText = `Retry ${attempt}/${retriesAllowed}: Running Deep DOM Diagnostics...`;
          diagnostics = await getAdvancedDiagnostics(tab);
      }
      
      let retryData = await callServerRetry(state.text, currentAnswers, postState.text, attempt, state.fields, diagnostics);
      if (!retryData || !retryData.answers) break;

      if (retryData.diagnostics_alert) {
          lastDiagnosticAlert = retryData.diagnostics_alert;
          console.warn("[AI DOM ANALYSIS]", lastDiagnosticAlert);
      }

      if (retryData.action === 'done' || currentAnswers.every(a => a.correct === true)) {
        await handleSuccess(currentAnswers, status, resultDiv);
        return;
      }
      
      validateAnswers(retryData.answers, state.fields.length);

      currentAnswers = currentAnswers.map((old, i) => {
          if (old.correct === true) return old; 
          const newAns = retryData.answers[i];
          if (!newAns || newAns.value === '' || newAns.value === undefined) return old;
          return { value: newAns.value, sign: newAns.sign || '', unit: newAns.unit || '', correct: false, isNeutral: old.isNeutral };
      });

      await fillAnswers(tab, currentAnswers);
      
      status.innerText = "Verifying retry inputs...";
      if (!(await verifyAllFilled(tab))) {
          throw new Error(`Safety Abort (Retry ${attempt}): React rejected the input fill. Aborting submit.`);
      }

      await clickSubmit(tab);
      await sleep(7000);

      postState = await scrapeFullState(tab);
      currentAnswers = postState.fields.map((f, i) => {
        let correctStatus = false;
        if (f.isCorrect) correctStatus = true;
        else if (f.invalid) correctStatus = false;
        else correctStatus = (f.value !== '');

        return {
            value: f.value,
            sign: currentAnswers[i]?.sign || '',
            unit: currentAnswers[i]?.unit || '',
            correct: correctStatus,
            isNeutral: !f.isCorrect && !f.invalid
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
    let finalOutput = "Final status:\n" + currentAnswers.map(a => `${a.sign || ''}${a.value} ${a.unit || ''} [${a.correct ? 'OK' : 'WRONG'}]`).join('\n') + "\n\nCheck manually.";
    
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
