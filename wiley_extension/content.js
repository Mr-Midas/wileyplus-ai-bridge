// content.js - Scrapes text AND identifies input fields
window.scrapeAndInteract = {
  // Scrape text (for the AI)
  getText: () => document.body.innerText,
  
  // Fill inputs and click buttons (The "Hands")
  fillAndSubmit: (answers, submitSelector, nextSelector) => {
    // 1. Find all inputs and textareas in order
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea'));
    
    answers.forEach((ans, i) => {
      if (inputs[i]) {
        inputs[i].value = ans;
        inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    
    // 2. Submit
    const submitBtn = document.querySelector(submitSelector);
    if (submitBtn) {
      submitBtn.click();
      return "Submitted";
    }
    return "Submit button not found";
  }
};
