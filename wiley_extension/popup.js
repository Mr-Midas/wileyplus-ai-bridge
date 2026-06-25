let autoNextEnabled = false;
let geminiTabId = null;
const GEMINI_URL = 'https://gemini.google.com/app/a4cd531f81f6f26d';

// --- UI Helpers (countdown + step bar) ---

function setStep(stepNum, state) {
  for (let i = 1; i <= 6; i++) {
    const el = document.getElementById('step' + i);
    if (!el) continue;
    el.className = 'step';
    if (i < stepNum) el.classList.add('done');
    else if (i === stepNum) el.classList.add(state || 'active');
  }
  const labels = ['', 'Opening Gemini', 'Waiting for page', 'Typing prompt', 'Sending prompt', 'Waiting for response', 'Reading JSON'];
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

async function getGeminiTab() {
  if (geminiTabId) {
    try {
      await chrome.tabs.get(geminiTabId);
      console.log("[Gemini] Reusing cached tab ID:", geminiTabId);
      return geminiTabId;
    } catch { console.log("[Gemini] Cached tab invalid"); }
  }
  const tabs = await chrome.tabs.query({ url: GEMINI_URL + '*' });
  if (tabs.length > 0) {
    geminiTabId = tabs[0].id;
    console.log("[Gemini] Found existing tab:", geminiTabId, tabs[0].url);
    return geminiTabId;
  }
  // Fallback: any Gemini conversation tab
  const anyTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/app/*' });
  if (anyTabs.length > 0) {
    console.log("[Gemini] Using generic Gemini tab:", anyTabs[0].id, anyTabs[0].url);
    geminiTabId = anyTabs[0].id;
    return geminiTabId;
  }
  console.log("[Gemini] Creating new tab at", GEMINI_URL);
  const tab = await chrome.tabs.create({ url: GEMINI_URL });
  // Wait for tab to finish loading (handles redirects)
  await new Promise(resolve => {
    const listener = (changedTabId, info) => {
      if (changedTabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 10000);
  });
  console.log("[Gemini] New tab loaded, URL:", tab.url);
  geminiTabId = tab.id;
  return geminiTabId;
}

async function focusGeminiTab() {
  const tabId = await getGeminiTab();
  await chrome.tabs.update(tabId, { active: true });
  return tabId;
}

async function waitForGeminiReady(tabId) {
  for (let i = 0; i < 60; i++) {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selectors = [
          'div[contenteditable="true"][role="textbox"]',
          'div.ql-editor[contenteditable="true"]',
          'rich-textarea div[contenteditable="true"]',
          'div[contenteditable="true"]',
          '[contenteditable="true"]'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) return 'ready:' + sel;
        }
        // Debug: list all contenteditable elements
        const all = Array.from(document.querySelectorAll('[contenteditable]')).map(e => e.tagName + (e.className ? '.' + e.className : ''));
        return 'no_textbox:' + all.join(', ');
      }
    });
    const res = r[0]?.result || '';
    if (res.startsWith('ready:')) {
      console.log("[Gemini] textbox found via:", res);
      return;
    }
    if (i % 10 === 0) console.log("[Gemini] waiting...", res);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("Gemini page did not load");
}

async function typeAndGetIconCoords(tabId, text) {
  console.log("[Gemini] typeAndGetIconCoords: text length =", text.length);
  const r = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (t) => {
      const selectors = [
        'div[contenteditable="true"][role="textbox"]',
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"]',
        '[contenteditable="true"]'
      ];
      let tb;
      for (const sel of selectors) {
        tb = document.querySelector(sel);
        if (tb) break;
      }
      if (!tb) return { error: 'no_textbox' };

      tb.focus();

      // 1. Force state update using execCommand (best for rich text frameworks)
      document.execCommand('selectAll', false, null);
      const success = document.execCommand('insertText', false, t);

      // 2. Fallback to direct manipulation + deep events
      if (!success) {
        tb.innerText = t;
        tb.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        tb.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }

      // 3. Wait 300ms for UI frameworks (React/Lit) to enable the send button
      await new Promise(resolve => setTimeout(resolve, 300));

      // 4. Find the button coordinates using modernized selectors
      const btnSelectors = [
        'button[aria-label="Send message"]',
        'button[aria-label="Send"]',
        'button[mattooltip="Send message"]',
        '[data-testid="send-button"]',
        '.send-button',
        'mat-icon[fonticon="send"]',
        'mat-icon[fonticon="arrow_upward"]',
        '[data-mat-icon-name="send"]',
        '[data-mat-icon-name="arrow_upward"]',
        'svg.send-icon'
      ];

      for (const sel of btnSelectors) {
        const iconOrBtn = document.querySelector(sel);
        if (iconOrBtn) {
          const rect = iconOrBtn.getBoundingClientRect();
          console.log("[Gemini] Target found via", sel, "at", rect.x, rect.y);
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height, selector: sel };
        }
      }

      console.log("[Gemini] Target NOT found");
      return { error: 'no_icon' };
    },
    args: [text]
  });
  const result = r[0]?.result || { error: 'unknown' };
  console.log("[Gemini] typeAndGetIconCoords result:", JSON.stringify(result));
  return result;
}

async function focusGeminiTextbox(tabId) {
  console.log("[Gemini] Focusing textbox...");
  const r = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const selectors = [
        'div[contenteditable="true"][role="textbox"]',
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"]',
        '[contenteditable="true"]'
      ];
      for (const sel of selectors) {
        const tb = document.querySelector(sel);
        if (tb) { tb.focus(); return 'focused:' + sel; }
      }
      return 'not_found';
    }
  });
  console.log("[Gemini] Focus result:", r[0]?.result);
  return r[0]?.result;
}

async function cdpSendCombo(tabId, x, y) {
  console.log("[CDP] cdpSendCombo: attach, then focus → Enter → mouse click at", x, y);
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        console.log("[CDP] attach error:", chrome.runtime.lastError.message);
        resolve('attach_failed');
        return;
      }
      let steps = 0;
      const checkDone = () => {
        steps++;
        if (steps >= 4) {
          chrome.debugger.detach({ tabId }, () => resolve('cdp_combo_done'));
        }
      };
      // Step 1: Focus textbox via Runtime.evaluate
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `document.querySelector('div[contenteditable="true"][role="textbox"], .ql-editor, rich-textarea div[contenteditable="true"], [contenteditable="true"]').focus()`,
        userGesture: true
      }, () => {
        console.log("[CDP] Focus done");
        checkDone();
        // Step 2: Send Enter (rawKeyDown + char + keyUp — full sequence)
        chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, isSystemKey: false
        }, () => {
          chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
            type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', windowsVirtualKeyCode: 13
          }, () => {
            chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, isSystemKey: false
            }, () => {
              console.log("[CDP] Enter sequence done");
              checkDone();
            });
          });
        });
        // Step 3: Mouse click at icon coordinates
        chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1
        }, () => {
          chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1
          }, () => {
            console.log("[CDP] Mouse click done");
            checkDone();
          });
        });
        // Extra: Step 4 — click at bottom-center of the icon (different spot)
        chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: x, y: y + 5, button: 'left', clickCount: 1
        }, () => {
          chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: x, y: y + 5, button: 'left', clickCount: 1
          }, () => {
            console.log("[CDP] Second mouse click done");
            checkDone();
          });
        });
      });
    });
  });
}

async function clickGeminiSendDom(tabId) {
  console.log("[Gemini] clickGeminiSendDom: trying DOM click...");
  const r = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const btnSelectors = [
        'button[aria-label="Send message"]',
        'button[aria-label="Send"]',
        'button[mattooltip="Send message"]',
        '[data-testid="send-button"]',
        '.send-button'
      ];
      
      for (const sel of btnSelectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
             return 'found_but_disabled:' + sel;
          }
          btn.click();
          return 'clicked_button:' + sel;
        }
      }

      const iconSelectors = [
        'mat-icon[fonticon="send"]',
        'mat-icon[fonticon="arrow_upward"]',
        '[data-mat-icon-name="send"]',
        '[data-mat-icon-name="arrow_upward"]',
        'svg.send-icon'
      ];
      
      for (const sel of iconSelectors) {
        const icon = document.querySelector(sel);
        if (icon) {
          const btn = icon.closest('button');
          if (btn) {
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
               return 'found_icon_btn_but_disabled:' + sel;
            }
            btn.click();
            return 'clicked_button_via_icon:' + sel;
          }
          icon.click();
          return 'clicked_icon_fallback:' + sel;
        }
      }
      return 'not_found';
    }
  });
  return r[0]?.result || 'error';
}

async function sendToGemini(tabId, x, y) {
  console.log("[Gemini] sendToGemini: starting");
  
  // Give the framework an extra moment to hydrate just in case
  await new Promise(r => setTimeout(r, 200));

  // Phase 1: DOM click
  const domResult = await clickGeminiSendDom(tabId);
  console.log("[Gemini] DOM click result:", domResult);

  if (domResult.includes('but_disabled')) {
      console.warn("[Gemini] WARNING: Button was disabled. Prompt might not be registered by the UI.");
  }

  // Phase 2: Focus textbox
  await focusGeminiTextbox(tabId);

  // Phase 3: CDP combo (focus → Enter → mouse click × 2)
  // This acts as a brute-force fallback to ensure the request goes through even if the DOM click failed.
  const cdpResult = await cdpSendCombo(tabId, x, y);
  console.log("[Gemini] CDP combo result:", cdpResult);

  const success = domResult?.startsWith('clicked') || cdpResult !== 'attach_failed';
  console.log("[Gemini] sendToGemini: overall success =", success);
  return success;
}

async function waitForGeminiResponse(tabId) {
  let prevLen = 0;
  let stableCount = 0;
  for (let i = 0; i < 120; i++) {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const textbox = document.querySelector('div[contenteditable="true"][role="textbox"], .ql-editor, rich-textarea div[contenteditable="true"], [contenteditable="true"]');
        const textboxEmpty = !textbox || textbox.innerText.trim() === '';
        const genIndicator = document.querySelector('[aria-label="Stop"], [aria-label="Stop generating"], [data-test-id="stop-button"], button[aria-label="Stop"], .generating-spinner, lm-generating');
        const codeBlock = document.querySelector('code[data-test-id="code-content"]');
        const bodyLen = document.body.innerText.length;
        return { textboxEmpty, generating: !!genIndicator, hasCodeBlock: !!codeBlock, codeText: codeBlock?.innerText || '', bodyLen };
      }
    });
    const s = r[0]?.result;
    if (!s) { console.log("[Gemini] wait poll", i, ": no result"); await new Promise(r => setTimeout(r, 1000)); continue; }
    if (i % 5 === 0 || i < 3) {
      console.log("[Gemini] wait poll", i, "bodyLen:", s.bodyLen, "gen:", s.generating, "tbEmpty:", s.textboxEmpty, "hasCodeBlock:", s.hasCodeBlock, "stable:", stableCount);
    }
    // Consider response done if: NOT generating AND (body stable OR has code block with answers)
    if (!s.generating && (s.hasCodeBlock || s.textboxEmpty)) {
      if (s.bodyLen === prevLen) {
        stableCount++;
        if (stableCount >= 3) {
          console.log("[Gemini] wait: response complete, body stable x3");
          await new Promise(r => setTimeout(r, 2000));
          return true;
        }
      } else {
        stableCount = 0;
      }
      prevLen = s.bodyLen;
    } else if (s.hasCodeBlock && s.codeText.includes('"answers"') && s.bodyLen > 100 && !s.generating) {
      console.log("[Gemini] wait: code block has answers, not generating");
      await new Promise(r => setTimeout(r, 2000));
      return true;
    } else if (i === 0) {
      console.log("[Gemini] wait: initial state, not yet generating (waiting for gen to start)");
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log("[Gemini] wait: TIMEOUT after 120s");
  return false;
}

async function readGeminiResponse(tabId) {
  console.log("[Gemini] readGeminiResponse: reading response from tab");
  const r = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Primary: JSON code blocks from Gemini's formatted output
      const codeBlocks = document.querySelectorAll('code[data-test-id="code-content"]');
      if (codeBlocks.length > 0) {
        const text = codeBlocks[codeBlocks.length - 1].innerText;
        console.log("[Gemini] Found code block, text length:", text.length);
        return text;
      }
      const preBlocks = document.querySelectorAll('.formatted-code-block-internal-container pre code');
      if (preBlocks.length > 0) {
        const text = preBlocks[preBlocks.length - 1].innerText;
        console.log("[Gemini] Found pre code block, text length:", text.length);
        return text;
      }
      // Secondary: model response text selectors
      const responseSelectors = [
        '[data-message-author-role="model"]',
        '.model-response',
        '.gemini-response',
        '.message-response .response-text',
        '[data-test-id="response-text"]',
        '.conversation-turn:last-child .response-text',
        '.turn:last-child .response'
      ];
      for (const sel of responseSelectors) {
        const matches = document.querySelectorAll(sel);
        if (matches.length > 0) {
          const text = matches[matches.length - 1].innerText;
          console.log("[Gemini] Found response via selector:", sel, "length:", text.length);
          return text;
        }
      }
      console.log("[Gemini] No response selectors matched, falling back to body.innerText");
      return document.body.innerText;
    }
  });
  const text = r[0]?.result || '';
  console.log("[Gemini] readGeminiResponse returned length:", text.length, "preview:", text.substring(0, 200));
  return text;
}

async function callGeminiWeb(problemText, inputCount, retryContext, wileyTabId) {
  console.log("[Gemini] callGeminiWeb: inputCount =", inputCount, "retry =", !!retryContext);
  let tabId;
  try {
    tabId = await getGeminiTab();
    console.log("[Gemini] Using tab ID:", tabId);
  } catch (e) {
    console.log("[Gemini] Could not get/create Gemini tab:", e.message);
    clearUI();
    return null;
  }
  try {
    // STEP 1: Activate Gemini tab
    setStep(1, 'active');
    console.log("[Gemini] STEP 1: Activating Gemini tab...");
    await chrome.tabs.update(tabId, { active: true });

    // STEP 2: Wait for page to be ready (textbox exists)
    setStep(2, 'active');
    console.log("[Gemini] STEP 2: Waiting for page ready...");
    await countdown(3, 'Waiting for Gemini page to load');
    await waitForGeminiReady(tabId);
    console.log("[Gemini] Page ready");

    // STEP 3: Type the prompt
    setStep(3, 'active');
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
{"answers":[{"value":"number","unit":"unit"},..."rules":{"value":"only number, no ranges, no units in value","unit":"s|m|m/s|m/s^2|cm/s^2|No units|km/h|km|min"}}]}`;
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
    console.log("[Gemini] STEP 3: Typing prompt, length:", prompt.length);
    const coords = await typeAndGetIconCoords(tabId, prompt);
    if (coords?.error === 'no_textbox') {
      console.log("[Gemini] Textbox not found — cannot proceed");
      setStep(3, 'error');
      clearUI();
      return null;
    }

    // STEP 4: Wait 5s, confirm page is fully loaded. Retry if not.
    setStep(4, 'active');
    console.log("[Gemini] STEP 4: Waiting 5s then confirming page ready...");
    await countdown(5, 'Confirming prompt typed');
    let pageReady = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const check = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const tb = document.querySelector('div[contenteditable="true"][role="textbox"], .ql-editor, rich-textarea div[contenteditable="true"], [contenteditable="true"]');
          return { hasTextbox: !!tb, textboxText: tb?.innerText?.substring(0, 100) || '' };
        }
      });
      const s = check[0]?.result;
      console.log("[Gemini] Page check attempt", attempt, ":", JSON.stringify(s));
      if (s?.hasTextbox && s.textboxText.length > 0) {
        pageReady = true;
        console.log("[Gemini] Page confirmed ready with text");
        break;
      }
      console.log("[Gemini] Page not ready yet, waiting 5s more...");
      await countdown(5, 'Retrying page check');
    }
    if (!pageReady) {
      console.log("[Gemini] Page never became ready after 5 attempts");
      setStep(4, 'error');
      clearUI();
      return null;
    }

    // STEP 5: Send the prompt
    console.log("[Gemini] STEP 5: Sending prompt...");
    if (coords?.error === 'no_icon') {
      console.log("[Gemini] No send icon, trying CDP Enter...");
      await focusGeminiTextbox(tabId);
      await cdpSendCombo(tabId, 0, 0);
    } else if (coords?.x) {
      await sendToGemini(tabId, coords.x, coords.y);
    } else {
      console.log("[Gemini] No coordinates, skipping send");
      setStep(5, 'error');
      clearUI();
      return null;
    }

    // STEP 6: Wait for JSON response
    setStep(6, 'active');
    console.log("[Gemini] STEP 6: Waiting for JSON response...");
    let jsonText = null;
    for (let attempt = 1; attempt <= 24; attempt++) {
      await countdown(5, 'Waiting for Gemini response');
      const check = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Check for JSON code block
          const codeBlock = document.querySelector('code[data-test-id="code-content"]');
          if (codeBlock) {
            const text = codeBlock.innerText;
            if (text.includes('"answers"')) {
              return { found: true, text: text, source: 'code_block' };
            }
          }
          // Check for pre code blocks
          const preBlocks = document.querySelectorAll('.formatted-code-block-internal-container pre code');
          for (const pb of preBlocks) {
            const text = pb.innerText;
            if (text.includes('"answers"')) {
              return { found: true, text: text, source: 'pre_block' };
            }
          }
          // Check for model response text with JSON
          const bodyText = document.body.innerText;
          const jsonMatch = bodyText.match(/\{[\s\S]*"answers"[\s\S]*\}/);
          if (jsonMatch) {
            return { found: true, text: jsonMatch[0], source: 'body_text' };
          }
          return { found: false, bodyLen: bodyText.length };
        }
      });
      const s = check[0]?.result;
      console.log("[Gemini] JSON check attempt", attempt, ":", s?.found ? "FOUND via " + s.source : "not found, bodyLen=" + s?.bodyLen);
      if (s?.found) {
        jsonText = s.text;
        console.log("[Gemini] JSON box confirmed, text length:", jsonText.length);
        break;
      }
      console.log("[Gemini] JSON not found yet, waiting...");
    }

    if (!jsonText) {
      console.log("[Gemini] JSON box never appeared after 24 attempts (120s)");
      setStep(6, 'error');
      clearUI();
      return null;
    }

    // STEP 7: Parse the JSON
    console.log("[Gemini] STEP 7: JSON copied, parsing...");
    const data = extractJSON(jsonText);
    if (data && data.answers) {
      console.log("[Gemini] Parsed OK, answers count:", data.answers.length);
      setStep(6, 'done');
      setTimeout(clearUI, 1500);
      return data;
    }
    console.log("[Gemini] Could not parse JSON from response. Preview:", jsonText.substring(0, 500));
    setStep(6, 'error');
    clearUI();
    return null;
    } finally {
      // STEP 8: Switch back to Wiley - with robust retry logic
      if (wileyTabId) {
        console.log("[Gemini] STEP 8: Switching back to Wiley tab:", wileyTabId);
        let switched = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const tab = await chrome.tabs.get(wileyTabId);
            if (tab && !tab.url.includes('gemini.google.com')) {
              await chrome.tabs.update(wileyTabId, { active: true });
              console.log("[Gemini] Successfully switched back to Wiley tab on attempt", attempt);
              switched = true;
              break;
            } else {
              console.log("[Gemini] Tab", wileyTabId, "is now a Gemini tab, trying to find Wiley tab by URL pattern...");
            }
          } catch (e) {
            console.log("[Gemini] Tab", wileyTabId, "not found on attempt", attempt, ":", e.message);
          }
          await new Promise(r => setTimeout(r, 500));
        }
        
        // Fallback: find Wiley tab by URL pattern if original tab lost
        if (!switched) {
          console.log("[Gemini] Fallback: searching for Wiley tab by URL pattern...");
          const patterns = ['*://*.wiley.com/*', '*://*.wileyplus.com/*', '*://*.wileyplus.knowmia.com/*'];
          for (const p of patterns) {
            const tabs = await chrome.tabs.query({ url: p });
            if (tabs.length > 0) {
              await chrome.tabs.update(tabs[0].id, { active: true });
              console.log("[Gemini] Switched to Wiley tab via pattern:", tabs[0].url);
              switched = true;
              break;
            }
          }
        }
        if (!switched) {
          console.error("[Gemini] CRITICAL: Could not switch back to any Wiley tab!");
        }
      }
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
