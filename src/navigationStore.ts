// Preferences must never make the document editor unavailable.
export const readPreference = (key: string, fallback: string): string => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
export const writePreference = (key: string, value: string): boolean => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
