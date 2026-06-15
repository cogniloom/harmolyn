export function safePrompt(message: string, defaultValue = ""): string | null {
  if (typeof window === "undefined" || typeof window.prompt !== "function") {
    return null;
  }

  try {
    return window.prompt(message, defaultValue);
  } catch {
    return null;
  }
}
