import os
import requests
import json
from playwright.sync_api import sync_playwright

# ================= CONFIGURATION =================
OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/generate"
MODEL_NAME = "hermes-qwen"
CDP_URL = "http://127.0.0.1:9229"
TARGET_KEYWORD = "wiley" # Look for tabs containing this keyword
# =================================================

def check_ollama():
    """Checks if the local Ollama server is running."""
    try:
        response = requests.get("http://127.0.0.1:11434/", timeout=2)
        return response.status_code == 200
    except requests.exceptions.RequestException:
        return False

def get_all_text_from_frames(page):
    """Recursively extracts text from the main page and all nested iframes."""
    text_content = [page.locator("body").text_content()]
    for frame in page.frames:
        try:
            text_content.append(frame.locator("body").text_content())
        except Exception:
            continue
    return "\n\n--- Frame Boundary ---\n\n".join(filter(None, text_content))

def query_local_ai(prompt_text):
    """Sends text to local AI and returns response."""
    payload = {
        "model": MODEL_NAME,
        "prompt": f"You are a physics expert. Analyze the following scraped text from a WileyPLUS assessment and provide a concise, accurate solution to the problem. If multiple questions are present, solve them sequentially.\n\nTEXT:\n{prompt_text}",
        "stream": False
    }
    try:
        response = requests.post(OLLAMA_ENDPOINT, json=payload, timeout=60)
        response.raise_for_status()
        return response.json().get("response", "No response from AI.")
    except Exception as e:
        return f"AI Error: {e}"

def run_automation_loop():
    """Main coordination loop."""
    print("\n--- WileyPLUS Attached Agent ---")
    
    if not check_ollama():
        print("\n[-] ERROR: Ollama is not running!")
        print("Please start Ollama (the application) and try again.")
        return

    with sync_playwright() as p:
        try:
            print(f"[*] Attempting to connect to Chrome at {CDP_URL}...")
            browser = p.chromium.connect_over_cdp(CDP_URL)
            context = browser.contexts[0]
            
            # Search all open tabs for a Wiley-related URL
            print("[*] Searching for WileyPLUS tab...")
            target_page = None
            for page in context.pages:
                if TARGET_KEYWORD.lower() in page.url.lower():
                    target_page = page
                    print(f"[+] Found Wiley tab: {page.url}")
                    break
            
            if not target_page:
                print("[-] Error: Could not find an open tab with 'wiley' in the URL.")
                print("Please make sure you have a WileyPLUS page open in the Chrome window started by Start_School_Chrome.bat")
                return

            # Bring the tab to the front
            target_page.bring_to_front()
            
            print("[*] Scraping page and iframes...")
            # Ensure page is loaded
            target_page.wait_for_load_state("networkidle")
            target_page.wait_for_timeout(2000)
            
            scraped_text = get_all_text_from_frames(target_page)
            
            if scraped_text and len(scraped_text.strip()) > 0:
                print("[*] Sending data to AI...")
                ai_answer = query_local_ai(scraped_text)
                
                print("\n" + "═"*60)
                print("🚀 AI SOLUTION")
                print("═"*60)
                print(ai_answer)
                print("═"*60 + "\n")
            else:
                print("[-] No text content found on the page. Is the question loaded?")
            
            # Do NOT close the browser because it's the user's main browser!
            browser.close() 
        except Exception as e:
            print(f"[-] Connection Error: {e}")
            print("\nMake sure you launched Chrome using 'Start_School_Chrome.bat'.")

if __name__ == "__main__":
    try:
        run_automation_loop()
    except KeyboardInterrupt:
        print("\nStopped by user.")
    except Exception as e:
        print(f"\nCritical Error: {e}")
    finally:
        print("\nDone. You can close this window.")
        input("Press Enter to exit...")
