import { Page, Cookie } from "playwright";

export interface AuthResult {
  success: boolean;
  cookies: Cookie[];
  redirectedTo: string;
}

interface FormField {
  selector: string;
  type: string;
  name: string;
  label: string;
}

/**
 * Detect login form fields from the page DOM.
 */
async function detectFormFields(page: Page): Promise<FormField[]> {
  return page.evaluate(() => {
    const fields: Array<{ selector: string; type: string; name: string; label: string }> = [];
    const inputs = document.querySelectorAll('form input:not([type="hidden"]):not([type="submit"])');

    for (const el of inputs) {
      const input = el as HTMLInputElement;
      const name = input.name || input.id || "";
      const type = input.type || "text";
      const id = input.id;

      let selector = "";
      if (id) {
        selector = `#${id}`;
      } else if (name) {
        selector = `input[name="${name}"]`;
      } else {
        selector = `input[type="${type}"]`;
      }

      let label = "";
      if (id) {
        const labelEl = document.querySelector(`label[for="${id}"]`);
        if (labelEl) label = labelEl.textContent?.trim() || "";
      }
      if (!label) {
        const parent = input.closest("label");
        if (parent) label = parent.textContent?.trim() || "";
      }
      if (!label) {
        label = input.placeholder || name || type;
      }

      fields.push({ selector, type, name, label });
    }

    return fields;
  });
}

/**
 * Read a line from stdin using raw mode for full control.
 * For hidden fields, shows * for each character.
 */
function readInput(label: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`  ${label}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    let value = "";
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === "\n" || c === "\r") {
        if (stdin.setRawMode) stdin.setRawMode(wasRaw || false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (c === "\u007f" || c === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          // Erase the last character on screen
          process.stdout.write("\b \b");
        }
      } else if (c === "\u0003") {
        // Ctrl+C during auth — restore terminal and reject
        if (stdin.setRawMode) stdin.setRawMode(wasRaw || false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve("");
      } else if (c.charCodeAt(0) >= 32) {
        // Only accept printable characters
        value += c;
        process.stdout.write(hidden ? "*" : c);
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * CLI-based auth with retry loop: detects login form fields, prompts user
 * in terminal, fills and submits via Playwright. Retries up to maxAttempts
 * times on failure. No browser window shown.
 */
export async function performCLIAuth(page: Page, maxAttempts = 3): Promise<AuthResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const fields = await detectFormFields(page);

    if (fields.length === 0) {
      return { success: false, cookies: [], redirectedTo: page.url() };
    }

    // Prompt user for each field using raw stdin
    let cancelled = false;
    for (const field of fields) {
      const hidden = field.type === "password";
      const value = await readInput(field.label, hidden);
      if (!value) {
        cancelled = true;
        break;
      }
      await page.fill(field.selector, value);
    }

    if (cancelled) {
      return { success: false, cookies: [], redirectedTo: page.url() };
    }

    // Submit the form
    const submitButton = await page.$('button[type="submit"], input[type="submit"], form button');
    if (submitButton) {
      await submitButton.click();
    } else {
      await page.press(fields[fields.length - 1].selector, "Enter");
    }

    // Wait for navigation away from login page
    try {
      await page.waitForURL(
        (url) => !/\/(login|signin|sign-in|auth)/i.test(url.pathname),
        { timeout: 10_000 }
      );
      await page.waitForLoadState("networkidle");

      const cookies = await page.context().cookies();
      return { success: true, cookies, redirectedTo: page.url() };
    } catch {
      if (attempt < maxAttempts) {
        process.stdout.write(`  Login failed. Try again (${maxAttempts - attempt} attempts remaining):\n`);
        // Reload login page for clean form state
        await page.reload({ waitUntil: "networkidle" });
      }
    }
  }

  return { success: false, cookies: [], redirectedTo: page.url() };
}
