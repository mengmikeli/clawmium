import { Page } from "playwright";

export interface LoginDetectionResult {
  isLoginPage: boolean;
  confidence: number;
  signals: Record<string, number>;
}

export async function detectLoginPage(page: Page): Promise<LoginDetectionResult> {
  const signals: Record<string, number> = {};
  let score = 0;

  // Signal 1: Password input (weight 40)
  const hasPasswordInput = await page.evaluate(() => {
    return document.querySelector('input[type="password"]') !== null;
  });
  if (hasPasswordInput) {
    signals["password_input"] = 40;
    score += 40;
  }

  // Signal 2: URL contains login/signin/auth (weight 30)
  const url = page.url().toLowerCase();
  if (/\/(login|signin|sign-in|auth)/.test(url)) {
    signals["url_pattern"] = 30;
    score += 30;
  }

  // Signal 3: Page title contains login patterns (weight 15)
  const title = await page.title();
  if (/sign\s*in|log\s*in|login|authentication/i.test(title)) {
    signals["title_pattern"] = 15;
    score += 15;
  }

  // Signal 4: Form with username + password fields (weight 10)
  const hasLoginForm = await page.evaluate(() => {
    const forms = document.querySelectorAll("form");
    for (const form of forms) {
      const hasPassword = form.querySelector('input[type="password"]') !== null;
      const hasUsername = form.querySelector(
        'input[type="text"], input[type="email"], input[name*="user"], input[name*="email"]'
      ) !== null;
      if (hasPassword && hasUsername) return true;
    }
    return false;
  });
  if (hasLoginForm) {
    signals["login_form"] = 10;
    score += 10;
  }

  // Signal 5: Submit button text matches login patterns (weight 5)
  const hasLoginButton = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, input[type="submit"]');
    for (const btn of buttons) {
      const text = (btn.textContent || (btn as HTMLInputElement).value || "").toLowerCase();
      if (/sign\s*in|log\s*in|login|submit/.test(text)) return true;
    }
    return false;
  });
  if (hasLoginButton) {
    signals["login_button"] = 5;
    score += 5;
  }

  // Signal 6: Search input (negative, weight -30)
  const hasSearchInput = await page.evaluate(() => {
    return document.querySelector(
      'input[type="search"], input[placeholder*="search" i], input[name*="search" i], input[aria-label*="search" i]'
    ) !== null;
  });
  if (hasSearchInput) {
    signals["search_input"] = -30;
    score -= 30;
  }

  // Signal 7: Content-heavy page (negative, weight -15)
  const linkCount = await page.evaluate(() => document.querySelectorAll("a[href]").length);
  if (linkCount > 20) {
    signals["many_links"] = -15;
    score -= 15;
  }

  const confidence = score / 100;

  return {
    isLoginPage: confidence >= 0.5,
    confidence,
    signals,
  };
}
