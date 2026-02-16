import type { Page } from "playwright";

export interface DetectedForm {
  type: "search" | "filter" | "input";
  label: string;         // "Search this site"
  selector: string;      // CSS selector of the primary input
  formSelector: string;  // CSS selector of the form (or "" for bare inputs)
  action: string;        // form action URL
}

export async function detectInteractiveForms(page: Page): Promise<DetectedForm[]> {
  try {
    return await page.evaluate(() => {
      const results: Array<{ type: "search" | "filter" | "input"; label: string; selector: string; formSelector: string; action: string }> = [];

      // 1. Check all <form> elements
      const forms = document.querySelectorAll("form");
      for (const form of forms) {
        if (results.length >= 3) break;

        // Skip forms with password fields (login forms — handled by auth)
        if (form.querySelector('input[type="password"]')) continue;

        const inputs = form.querySelectorAll("input, textarea");
        if (inputs.length === 0) continue;

        // Classify the form
        const action = form.getAttribute("action") || "";
        const formId = form.id ? `#${form.id}` : "";
        const formSelector = formId || `form[action="${action}"]`;

        // Check for search indicators
        // Note: helpers are inlined to avoid esbuild __name() wrapping in page.evaluate()
        const isSearch = Array.from(inputs).some(input => {
          const el = input as HTMLInputElement;
          return (
            el.type === "search" ||
            (el.name || "").toLowerCase().includes("q") && el.name!.length <= 5 ||
            (el.name || "").toLowerCase().includes("search") ||
            (el.placeholder || "").toLowerCase().includes("search") ||
            (el.getAttribute("aria-label") || "").toLowerCase().includes("search")
          );
        }) || (action || "").toLowerCase().includes("search");

        if (isSearch) {
          // Find the primary search input
          const searchInput = form.querySelector(
            'input[type="search"], input[name*="q"], input[name*="search"], input[placeholder*="earch"], textarea[name*="q"], textarea[name*="search"], textarea[placeholder*="earch"]'
          ) as HTMLInputElement | HTMLTextAreaElement | null;
          if (searchInput) {
            const tag = searchInput.tagName.toLowerCase();
            const inputSelector = searchInput.id
              ? `#${searchInput.id}`
              : searchInput.name
                ? `${tag}[name="${searchInput.name}"]`
                : `form${formId} input[type="search"], form${formId} input[name*="q"], form${formId} textarea[name*="q"]`;
            results.push({
              type: "search",
              label: (() => {
                const hint = searchInput.placeholder || searchInput.getAttribute("aria-label") || "";
                // Avoid tautological labels like Search: "Search" — use the hint only when descriptive
                if (!hint || /^search$/i.test(hint.trim())) return "Search this site";
                return `Search: "${hint}"`;
              })(),
              selector: inputSelector,
              formSelector,
              action,
            });
          }
          continue;
        }

        // Check for filter forms (selects, checkboxes)
        const hasSelect = form.querySelector("select") !== null;
        const hasCheckbox = form.querySelector('input[type="checkbox"]') !== null;
        if (hasSelect || hasCheckbox) {
          results.push({
            type: "filter",
            label: "Filter results",
            selector: formSelector,
            formSelector,
            action,
          });
          continue;
        }
      }

      // 2. Detect standalone search inputs not inside a <form>
      if (results.length < 3) {
        const allInputs = document.querySelectorAll('input[type="search"], input[name="q"], input[placeholder*="earch"], textarea[name="q"], textarea[name*="search"]');
        for (const input of allInputs) {
          if (results.length >= 3) break;
          if (input.closest("form")) continue; // already handled above

          const el = input as HTMLInputElement;
          const tag = el.tagName.toLowerCase();
          const selector = el.id
            ? `#${el.id}`
            : el.name
              ? `${tag}[name="${el.name}"]`
              : 'input[type="search"]';

          // Check if we already have this selector
          if (results.some(r => r.selector === selector)) continue;

          results.push({
            type: "search",
            label: (() => {
              const hint = el.placeholder || el.getAttribute("aria-label") || "";
              if (!hint || /^search$/i.test(hint.trim())) return "Search this site";
              return `Search: "${hint}"`;
            })(),
            selector,
            formSelector: "",
            action: "",
          });
        }
      }

      return results;
    });
  } catch {
    return [];
  }
}
